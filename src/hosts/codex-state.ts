import {
  runtimeExecutableProtection,
  prepareRuntimeState,
  candidateArtifactEnvironment,
  candidateArtifactReadRoots,
  codexStateEnabled,
  retainCandidateCodexState,
  requireNativeHookRoots,
} from "../runtime/index";
import { shellQuote } from "../platform/index";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isMissingFile } from "../kernel/index";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
type Request = Parameters<HostAdapter["run"]>[0];
type CodexState = Awaited<ReturnType<typeof prepareCodexState>>;
const MAX_AUTH_BYTES = 1024 * 1024;

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

export async function codexHookMounts(
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
  await grantCodexHookReads(state, hooks.directories);
  return hooks;
}

/** Hooks advertise paths relative to these curated copies, not the install cache. */
async function grantCodexHookReads(
  state: CodexState,
  roots: string[],
): Promise<void> {
  if (roots.length === 0) return;
  await requireNativeHookRoots(roots, state.codexHome);
  const path = join(state.codexHome, "config.toml");
  const config = await readFile(path, "utf8");
  const header = `[permissions.${state.profileId}.filesystem]\n`;
  const grants = roots
    .map((root) => `${JSON.stringify(root)} = "read"\n`)
    .join("");
  await writeFile(path, config.replace(header, header + grants), {
    mode: 0o600,
  });
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
  paths: Awaited<ReturnType<typeof privateCodexDirectories>>,
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
  paths: Awaited<ReturnType<typeof privateCodexDirectories>>,
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
  paths: Awaited<ReturnType<typeof privateCodexDirectories>>,
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
  paths: Awaited<ReturnType<typeof privateCodexDirectories>>,
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
  paths: Awaited<ReturnType<typeof privateCodexDirectories>>,
): void {
  if (runtime)
    Object.assign(env, runtime.environment, {
      HOME: paths.parentHome,
      TMPDIR: paths.parentTemp,
    });
}

export async function prepareCodexState(
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
  const policy = await codexIsolationPolicy(
    stateRoot,
    options,
    request,
    paths,
    readRoots,
    runtime?.root,
  );
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
  return { ...paths, stateRoot, sandboxBinary, profileId, env, protectedRoots };
}

function codexStateWriteRoots(
  request: Request,
  paths: Awaited<ReturnType<typeof privateCodexDirectories>>,
): string[] {
  return codexStateEnabled(request.runtimePolicy)
    ? [
        join(paths.codexHome, "skills"),
        join(paths.parentHome, ".agents", "skills"),
        join(paths.commandHome, ".agents", "skills"),
        join(paths.commandHome, ".codex", "skills"),
      ]
    : [];
}

async function prepareCodexStateEvidence(
  request: Request,
  stateRoot: string,
  paths: Awaited<ReturnType<typeof privateCodexDirectories>>,
): Promise<void> {
  if (!codexStateEnabled(request.runtimePolicy)) return;
  const skillRoots = codexStateWriteRoots(request, paths);
  await Promise.all(
    skillRoots.map((root) => mkdir(root, { recursive: true, mode: 0o700 })),
  );
  await mkdir(join(paths.codexHome, "skills", ".system"), { mode: 0o700 });
  await retainCandidateCodexState(
    request.candidateRuntimeRoot,
    stateRoot,
    paths,
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
  paths: Awaited<ReturnType<typeof privateCodexDirectories>>,
  readRoots: string[],
  runtimeRoot: string | undefined,
) {
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
  });
}

function codexProfileEnvironmentSource(
  runtime: Awaited<ReturnType<typeof codexRuntime>>,
  request: Request,
) {
  return runtime?.environment ?? request.runtimePolicy?.environment;
}
