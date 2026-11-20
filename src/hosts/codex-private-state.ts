/**
 * The Codex private state of one native host request: its layout, plugin and
 * hook installation, skill tracking, the single rendered permission profile,
 * retention in the candidate runtime and the isolation preflight.
 */
import {
  runtimeExecutableProtection,
  prepareRuntimeState,
  candidateArtifactEnvironment,
  candidateArtifactReadRoots,
  retainCandidatePrivateState,
  type CandidateArtifactPath,
} from "../runtime/index";
import { shellQuote } from "../platform/index";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isMissingFile } from "../kernel/index";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import type { HostAdapter } from "../host-contract/index";
import {
  candidateTranscriptEnvironment,
  candidateTranscriptRoots,
} from "../transcripts/index";
import { prepareHookMounts } from "../hooks/index";
import { codexPermissionProfile } from "../codex-profile/index";
import {
  createIsolationPolicy,
  type IsolationPolicy,
} from "../isolation/index";
import { installCodexPlugins } from "./codex-marketplace";
import {
  codexSkillCatalogRoots,
  prepareSkillTracking,
  type SkillTracking,
} from "../skill-tracking/index";
import { CodexProcessFailure, runCodexProcess } from "../native-process/index";
import type { HostDiagnostics } from "../diagnostics/index";
import type { NativeHostRequestContext } from "./native-host-request";
type Request = Parameters<HostAdapter["run"]>[0];
type CodexPaths = Awaited<ReturnType<typeof privateCodexDirectories>>;
type CodexState = Awaited<ReturnType<typeof prepareCodexState>>;
const MAX_AUTH_BYTES = 1024 * 1024;

/** Prepared Codex private state, ready for turns. */
export interface CodexPrivateState {
  state: CodexState;
  skillTracking: SkillTracking;
}

/** The four user-skill locations, keyed by their reserved candidate artifact names. */
type CodexSkillRoots = Record<
  | "codex_skills"
  | "agent_skills"
  | "command_agent_skills"
  | "command_codex_skills",
  { directory: string; boundary: string }
>;

export interface CodexHostOptions {
  binary: string;
  authFile: string;
  model: string;
  effort: string;
  projectRoot: string;
  resultsRoot: string;
  additionalProtectedRoots: string[];
  agentConcurrencyLimit?: number | null;
  timeoutMs?: number;
  entrypoint?: "exec" | "app-server";
  retainHostDiagnostics?: boolean;
  /** Integration-test seam; production uses the same CLI for execution and preflight. */
  sandboxBinary?: string;
}

async function copyAuth(source: string, target: string): Promise<void> {
  let bytes: Buffer;
  try {
    if ((await stat(source)).size > MAX_AUTH_BYTES)
      throw new Error("Codex auth file exceeds the size limit");
    bytes = await readFile(source);
  } catch (error) {
    throw new Error("Codex auth file is unreadable or oversized", {
      cause: error,
    });
  }
  if (bytes.byteLength > MAX_AUTH_BYTES)
    throw new Error("Codex auth file exceeds the size limit");
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
}

/**
 * Prepare the complete private state in its required order. The permission
 * profile is rendered once, before plugin installation runs Codex, so every
 * read grant (including curated hook mounts) is planned from the layout.
 */
export async function prepareCodexPrivateState(
  context: NativeHostRequestContext,
  options: CodexHostOptions,
  limit: number | null,
): Promise<CodexPrivateState> {
  const { request, diagnostics, stateRoot } = context;
  const helperRoot =
    process.platform === "linux"
      ? await mkdtemp(join(tmpdir(), "sevro-codex-helper-"))
      : undefined;
  if (helperRoot) context.cleanupRoots.push(helperRoot);
  const state = await prepareCodexState(
    stateRoot,
    options,
    limit,
    request,
    helperRoot,
  );
  const installedPluginRoots = await installCodexPlugins({
    binary: options.binary,
    env: state.env,
    pluginCacheRoot: state.pluginCacheRoot,
    request,
    diagnostics,
  });
  diagnostics.stage = "hooks-preparation";
  context.hooks = await codexHookMounts(request, state, installedPluginRoots);
  const skillTracking = await prepareCodexSkillTracking(
    state,
    installedPluginRoots,
  );
  await codexPreflight(options, request, state, diagnostics);
  return { state, skillTracking };
}

/** Each curated hook mount `prepareHookMounts` creates for a declared plugin. */
function plannedHookRoots(request: Request, stateRoot: string): string[] {
  return (request.codexMarketplace?.pluginNames ?? []).map((_, index) =>
    join(stateRoot, "runtime-plugins", `plugin-${index}`),
  );
}

/** Grants are validated against existing directories, so create them first. */
async function createPlannedHookRoots(roots: string[]): Promise<void> {
  for (const root of roots) await mkdir(root, { recursive: true, mode: 0o700 });
}

function codexSkillRoots(paths: CodexPaths): CodexSkillRoots {
  return {
    codex_skills: {
      directory: join(paths.codexHome, "skills"),
      boundary: paths.codexHome,
    },
    agent_skills: {
      directory: join(paths.parentHome, ".agents", "skills"),
      boundary: paths.parentHome,
    },
    command_agent_skills: {
      directory: join(paths.commandHome, ".agents", "skills"),
      boundary: paths.commandHome,
    },
    command_codex_skills: {
      directory: join(paths.commandHome, ".codex", "skills"),
      boundary: paths.commandHome,
    },
  };
}

function codexArtifacts(
  paths: CodexPaths,
): Record<string, CandidateArtifactPath> {
  return {
    codex_config: { path: join(paths.codexHome, "config.toml"), file: true },
    ...Object.fromEntries(
      Object.entries(codexSkillRoots(paths)).map(([name, root]) => [
        name,
        { path: root.directory },
      ]),
    ),
  };
}

async function prepareCodexSkillTracking(
  state: CodexState,
  pluginRoots: string[],
): Promise<SkillTracking> {
  const roots = await codexSkillCatalogRoots(
    state.workspace,
    pluginRoots,
    Object.values(codexSkillRoots(state)),
  );
  const tracking = await prepareSkillTracking({
    privateRoot: state.codexHome,
    host: "codex",
    roots,
  });
  await writeFile(
    join(state.codexHome, "hooks.json"),
    JSON.stringify({ hooks: tracking.hooks }),
    { flag: "wx", mode: 0o600 },
  );
  return tracking;
}

function sandboxArgs(
  state: CodexState,
  request: Request,
  command: string[],
): string[] {
  return [
    state.sandboxBinary,
    "sandbox",
    "-P",
    state.profileId,
    "-C",
    request.workspace,
    ...command,
  ];
}

async function sandboxPreflight(
  state: CodexState,
  request: Request,
  command: string[],
  diagnostics: HostDiagnostics,
) {
  return runCodexProcess({
    diagnostics,
    argv: sandboxArgs(state, request, command),
    cwd: request.workspace,
    env: state.env,
    timeoutMs: 60_000,
    phase: "isolation-preflight",
    signal: request.signal,
  });
}

/** Prove the rendered profile denies credentials before any turn runs. */
async function codexPreflight(
  options: CodexHostOptions,
  request: Request,
  state: CodexState,
  diagnostics: HostDiagnostics,
): Promise<void> {
  diagnostics.stage = "isolation-preflight";
  const probe = join(state.commandTemp, "isolation-probe");
  await writeFile(probe, "probe\n", { flag: "wx", mode: 0o600 });
  const checked = await sandboxPreflight(
    state,
    request,
    [
      "/bin/sh",
      "-c",
      '/bin/cat "$1" >/dev/null && ! /bin/ls "$2" >/dev/null 2>&1 && ! /bin/cat "$3" >/dev/null 2>&1 && ! /bin/cat "$4" >/dev/null 2>&1 || exit 70; "$5" --version >/dev/null 2>&1 || exit 71',
      "sevro-probe",
      probe,
      options.projectRoot,
      join(state.codexHome, "auth.json"),
      // The opt-in config read is tested separately; credentials always stay denied.
      join(
        state.codexHome,
        request.runtimePolicy?.codexState === true
          ? "auth.json"
          : "config.toml",
      ),
      state.sandboxBinary,
    ],
    diagnostics,
  );
  if (checked.code === 71)
    throw new CodexProcessFailure("executable-preflight", checked);
  if (checked.code !== 0)
    throw new CodexProcessFailure("isolation-preflight", checked);
  await rm(probe);
}

async function codexHookMounts(
  request: Request,
  state: CodexState,
  installedPluginRoots: string[],
) {
  const hooks = await prepareHookMounts({
    workspace: request.workspace,
    stateRoot: state.stateRoot,
    privateRoot: state.codexHome,
    pluginRoots: installedPluginRoots,
    protectedRoots: state.protectedRoots,
    policy: request.runtimePolicy ?? {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
    },
  });
  for (const [index, root] of installedPluginRoots.entries()) {
    const curated = hooks.directories[index];
    if (!curated) throw new Error("Codex hook projection is incomplete");
    await rm(root, { recursive: true });
    await cp(curated, root, { recursive: true });
  }
  requirePlannedHookRoots(state.hookRoots, hooks.directories);
  return hooks;
}

/** Hooks advertise paths relative to these curated copies, which the profile already grants. */
function requirePlannedHookRoots(planned: string[], actual: string[]): void {
  if (
    planned.length !== actual.length ||
    planned.some((root, index) => root !== actual[index])
  )
    throw new Error("Codex hook mounts differ from the planned read grants");
}

async function privateCodexDirectories(stateRoot: string) {
  const codexHome = join(stateRoot, "codex-home"),
    parentHome = join(stateRoot, "home"),
    parentTemp = join(stateRoot, "tmp"),
    commandHome = join(stateRoot, "command-home"),
    commandTemp = join(stateRoot, "command-tmp");
  await Promise.all(
    [codexHome, parentHome, parentTemp, commandHome, commandTemp].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );
  if (process.platform === "linux")
    await mkdir(join(codexHome, "tmp", "arg0"), {
      recursive: true,
      mode: 0o700,
    });
  return {
    codexHome,
    parentHome,
    parentTemp,
    commandHome,
    commandTemp,
    pluginCacheRoot: join(codexHome, "plugins", "cache"),
  };
}

function requireUnprotectedExecutables(
  readRoots: string[],
  protectedRoots: string[],
): void {
  if (
    readRoots.some((readRoot) =>
      protectedRoots.some(
        (root) => readRoot === root || readRoot.startsWith(`${root}${sep}`),
      ),
    )
  )
    throw new Error("Codex executable resides inside a protected root");
}

function concurrencyConfiguration(limit: number | null): string {
  return limit === null
    ? ""
    : `\n[agents]\nmax_concurrent_threads_per_session = ${limit}\n`;
}

async function writeCodexProfile(
  paths: CodexPaths,
  profileId: string,
  request: Request,
  policy: IsolationPolicy,
  limit: number | null,
  commandEnvironment: Record<string, string> | undefined,
): Promise<void> {
  const profile = codexPermissionProfile({
    id: profileId,
    policy,
    commandEnvironment: codexProfileEnvironment(
      request,
      paths,
      commandEnvironment,
    ),
  });
  await writeFile(
    join(paths.codexHome, "config.toml"),
    profile +
      concurrencyConfiguration(limit) +
      fixtureTrustConfiguration(request),
    { flag: "wx", mode: 0o600 },
  );
}

function fixtureTrustConfiguration(request: Request): string {
  return `\n[projects.${JSON.stringify(request.workspace)}]\ntrust_level = "untrusted"\n`;
}

function codexProfileEnvironment(
  request: Request,
  paths: CodexPaths,
  environment: Record<string, string> | undefined,
) {
  return {
    ...codexCommandEnvironment(request, environment),
    ...codexTranscriptEnvironment(request, paths.codexHome),
    ...candidateTranscriptEnvironment(request.candidateTranscriptRoot),
    ...candidateArtifactEnvironment(request.candidateArtifactRoots),
    ...(request.runtimePolicy?.codexState === true
      ? {
          SEVRO_CODEX_AGENT_SKILLS: join(paths.parentHome, ".agents", "skills"),
        }
      : {}),
  };
}

function codexTranscriptEnvironment(
  request: Request,
  home: string,
): Record<string, string> {
  return {
    ...(request.runtimePolicy?.codexState === true ? { CODEX_HOME: home } : {}),
    ...(request.runtimePolicy?.nativeTranscripts === true
      ? {
          CODEX_HOME: home,
          SEVRO_NATIVE_TRANSCRIPT_ROOT: join(home, "sessions"),
        }
      : {}),
  };
}

function codexNativeReadRoots(request: Request, home: string) {
  return [
    ...linuxArg0ReadRoots(home),
    ...(request.runtimePolicy?.codexState === true
      ? [join(home, "config.toml"), join(home, "skills", ".system")]
      : []),
    ...codexTranscriptRoots(request, home),
    ...candidateTranscriptRoots(request.candidateTranscriptRoot),
    ...candidateArtifactReadRoots(request.candidateArtifactRoots),
  ];
}

function codexTranscriptRoots(request: Request, home: string) {
  return request.runtimePolicy?.nativeTranscripts === true
    ? [join(home, "sessions")]
    : [];
}

function linuxArg0ReadRoots(codexHome: string): string[] {
  return process.platform === "linux" ? [join(codexHome, "tmp", "arg0")] : [];
}

function codexHelperBinary(options: CodexHostOptions, sandboxBinary: string) {
  const sibling = join(dirname(options.binary), "codex-linux-sandbox");
  return (
    options.sandboxBinary ?? (existsSync(sibling) ? sibling : sandboxBinary)
  );
}

function codexCommandEnvironment(
  request: Request,
  environment: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!environment) return undefined;
  const path =
    environment.PATH ??
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    ...environment,
    PATH: [request.fixtureBinDir, path].filter(Boolean).join(delimiter),
  };
}

async function fixtureShellRoot(
  request: Request,
  parentHome: string,
): Promise<string> {
  const root = join(request.workspace, ".git", "sevro-shell");
  if (request.fixtureBinDir) {
    await mkdir(root, { mode: 0o700 });
    await writeFile(
      process.platform === "linux"
        ? join(parentHome, ".bash_profile")
        : join(root, ".zprofile"),
      `export PATH=${shellQuote(request.fixtureBinDir)}:"$PATH"\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
  return root;
}

function codexPath(fixtureBin: string | undefined): string {
  const path = process.env.PATH ?? "/usr/bin:/bin";
  return fixtureBin ? `${fixtureBin}${delimiter}${path}` : path;
}

function codexEnvironment(
  paths: CodexPaths,
  request: Request,
  shellRoot: string,
): Record<string, string> {
  return {
    ...request.runtimePolicy?.environment,
    PATH: declaredCodexPath(request),
    LANG: process.env.LANG ?? "C",
    HOME: paths.parentHome,
    TMPDIR: paths.parentTemp,
    CODEX_HOME: paths.codexHome,
    NO_COLOR: "1",
    ...(request.fixtureBinDir && process.platform === "darwin"
      ? { ZDOTDIR: shellRoot }
      : {}),
  };
}

function declaredCodexPath(request: Request): string {
  return (
    request.runtimePolicy?.environment.PATH ?? codexPath(request.fixtureBinDir)
  );
}

async function codexRuntime(
  request: Request,
  paths: CodexPaths,
  stateRoot: string,
) {
  if (!request.runtimePolicy) return undefined;
  const runtime = await prepareRuntimeState(
    request.workspace,
    request.runtimePolicy,
    request.runtimeRole ?? "candidate",
    request.candidateRuntimeRoot ?? join(stateRoot, "runtime"),
  );
  paths.commandHome = runtime.home;
  paths.commandTemp = runtime.temp;
  return runtime;
}

function applyCodexRuntime(
  runtime: Awaited<ReturnType<typeof codexRuntime>>,
  env: Record<string, string>,
  paths: CodexPaths,
): void {
  if (runtime)
    Object.assign(env, runtime.environment, {
      HOME: paths.parentHome,
      TMPDIR: paths.parentTemp,
    });
}

async function prepareCodexState(
  stateRoot: string,
  options: CodexHostOptions,
  limit: number | null,
  request: Request,
  helperRoot?: string,
) {
  await requireIsolatedGitMetadata(request.workspace);
  const paths = await privateCodexDirectories(stateRoot);
  const runtime = await codexRuntime(request, paths, stateRoot);
  await copyAuth(options.authFile, join(paths.codexHome, "auth.json"));
  const sandboxBinary = options.sandboxBinary ?? options.binary;
  const helperBinary = codexHelperBinary(options, sandboxBinary);
  if (helperRoot)
    await symlink(helperBinary, join(helperRoot, "codex-linux-sandbox"));
  const readRoots = await Promise.all(
    [options.binary, sandboxBinary, helperBinary].flatMap((binary) => [
      realpath(dirname(binary)),
      realpath(binary).then(dirname),
    ]),
  );
  if (helperRoot) readRoots.push(helperRoot);
  const hookRoots = plannedHookRoots(request, stateRoot);
  await createPlannedHookRoots(hookRoots);
  const policy = await codexIsolationPolicy(stateRoot, options, request, {
    paths,
    readRoots,
    hookRoots,
    runtimeRoot: runtime?.root,
  });
  const protectedRoots = policy.deny;
  requireUnprotectedExecutables(
    readRoots,
    runtimeExecutableProtection(
      readRoots,
      protectedRoots,
      Boolean(request.runtimePolicy),
    ),
  );
  const profileId = `sevro_${randomUUID().replaceAll("-", "")}`;
  await writeCodexProfile(
    paths,
    profileId,
    request,
    policy,
    limit,
    codexProfileEnvironmentSource(runtime, request),
  );
  const shellRoot = await fixtureShellRoot(request, paths.parentHome);
  const env = codexEnvironment(paths, request, shellRoot);
  applyCodexRuntime(runtime, env, paths);
  await prepareCodexStateEvidence(request, stateRoot, paths);
  return {
    ...paths,
    stateRoot,
    workspace: request.workspace,
    sandboxBinary,
    profileId,
    env,
    protectedRoots,
    hookRoots,
  };
}

function codexStateWriteRoots(request: Request, paths: CodexPaths): string[] {
  return request.runtimePolicy?.codexState === true
    ? Object.values(codexSkillRoots(paths)).map((root) => root.directory)
    : [];
}

async function prepareCodexStateEvidence(
  request: Request,
  stateRoot: string,
  paths: CodexPaths,
): Promise<void> {
  if (request.runtimePolicy?.codexState !== true) return;
  const skillRoots = codexStateWriteRoots(request, paths);
  await Promise.all(
    skillRoots.map((root) => mkdir(root, { recursive: true, mode: 0o700 })),
  );
  await mkdir(join(paths.codexHome, "skills", ".system"), { mode: 0o700 });
  await retainCandidatePrivateState(
    request.candidateRuntimeRoot,
    stateRoot,
    codexArtifacts(paths),
  );
}

async function requireIsolatedGitMetadata(workspace: string): Promise<void> {
  try {
    if (!(await lstat(join(workspace, ".git"))).isDirectory())
      throw new Error("Codex Git metadata must be an isolated directory");
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
  }
}

function codexIsolationPolicy(
  stateRoot: string,
  options: CodexHostOptions,
  request: Request,
  grants: {
    paths: CodexPaths;
    readRoots: string[];
    hookRoots: string[];
    runtimeRoot: string | undefined;
  },
) {
  const { paths, readRoots, hookRoots, runtimeRoot } = grants;
  return createIsolationPolicy({
    subject: "host",
    workspace: request.workspace,
    privateStateRoot: stateRoot,
    protection: {
      projectRoot: options.projectRoot,
      resultsRoot: options.resultsRoot,
      additionalRoots: [
        ...options.additionalProtectedRoots,
        ...(process.platform === "linux" ? [] : [stateRoot]),
      ],
    },
    runtimePolicy: request.runtimePolicy,
    runtimeRole: request.runtimeRole,
    network: "deny",
    writableRuntimeRoot: runtimeRoot,
    nativeReadRoots: codexNativeReadRoots(request, paths.codexHome),
    nativeWriteRoots: codexStateWriteRoots(request, paths),
    commandHome: paths.commandHome,
    commandTemp: paths.commandTemp,
    executableReadRoots: readRoots,
    pluginReadRoots: request.codexMarketplace ? [paths.pluginCacheRoot] : [],
    hookReadRoots: hookRoots,
  });
}

function codexProfileEnvironmentSource(
  runtime: Awaited<ReturnType<typeof codexRuntime>>,
  request: Request,
) {
  return runtime?.environment ?? request.runtimePolicy?.environment;
}
