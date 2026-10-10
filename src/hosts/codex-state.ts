import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, sep } from "node:path";
import type { HostAdapter } from "../engine";
import {
  candidateTranscriptEnvironment,
  candidateTranscriptRoots,
} from "../native-transcripts";
import { prepareHookMounts } from "../runtime-hooks";
import {
  requireRuntimeReadRoots,
  runtimeExecutableProtection,
} from "../runtime-paths";
import { prepareRuntimeState } from "../runtime-state";
import { codexPermissionProfile } from "./codex-profile";
import { evaluationProtectedRoots } from "./isolation-roots";
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function codexHookMounts(
  request: Request,
  state: CodexState,
  installedPluginRoots: string[],
) {
  if (!request.runtimePolicy) return undefined;
  const hooks = await prepareHookMounts({
    workspace: request.workspace,
    stateRoot: join(request.workspace, ".git", "sevro-runtime"),
    privateRoot: state.codexHome,
    pluginRoots: installedPluginRoots,
    protectedRoots: state.protectedRoots,
    policy: request.runtimePolicy,
  });
  for (const [index, root] of installedPluginRoots.entries()) {
    const curated = hooks.directories[index];
    if (!curated) throw new Error("Codex hook projection is incomplete");
    await rm(root, { recursive: true });
    await cp(curated, root, { recursive: true });
  }
  return hooks;
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
  readRoots: string[],
  protectedRoots: string[],
  limit: number | null,
  commandEnvironment = request.runtimePolicy?.environment,
  runtimeWriteRoot?: string,
): Promise<void> {
  const profile = codexPermissionProfile({
    commandEnvironment: codexProfileEnvironment(
      request,
      paths,
      commandEnvironment,
    ),
    runtimeWriteRoot,
    runtimeReadRoots: request.runtimePolicy?.readOnlyRoots,
    nativeReadRoots: codexNativeReadRoots(request, paths.codexHome),
    id: profileId,
    workspace: request.workspace,
    commandHome: paths.commandHome,
    commandTemp: paths.commandTemp,
    executableReadRoots: readRoots,
    ...codexPluginReadRoot(request, paths.pluginCacheRoot),
    protectedRoots,
  });
  await writeFile(
    join(paths.codexHome, "config.toml"),
    profile + concurrencyConfiguration(limit),
    { flag: "wx", mode: 0o600 },
  );
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
  };
}

function codexTranscriptEnvironment(
  request: Request,
  home: string,
): Record<string, string> {
  return request.runtimePolicy?.nativeTranscripts === true
    ? { CODEX_HOME: home, SEVRO_NATIVE_TRANSCRIPT_ROOT: join(home, "sessions") }
    : {};
}

function codexNativeReadRoots(request: Request, home: string) {
  return [
    ...linuxArg0ReadRoots(home),
    ...codexTranscriptRoots(request, home),
    ...candidateTranscriptRoots(request.candidateTranscriptRoot),
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

function codexPluginReadRoot(request: Request, root: string) {
  return request.codexMarketplace ? { pluginReadRoot: root } : {};
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

function codexSeedSources(request: Request): string[] {
  return (request.runtimePolicy?.seeds ?? []).map((seed) => seed.source);
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
    join(stateRoot, "runtime"),
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

function codexRuntimeProfile(
  runtime: Awaited<ReturnType<typeof codexRuntime>>,
) {
  return { environment: runtime?.environment, root: runtime?.root };
}

export async function prepareCodexState(
  stateRoot: string,
  options: CodexHostOptions,
  limit: number | null,
  request: Request,
  helperRoot?: string,
) {
  const paths = await privateCodexDirectories(stateRoot);
  const runtime = await codexRuntime(request, paths, stateRoot);
  await copyAuth(options.authFile, join(paths.codexHome, "auth.json"));
  const protectedRoots = await evaluationProtectedRoots({
    workspace: request.workspace,
    projectRoot: options.projectRoot,
    resultsRoot: options.resultsRoot,
    additionalRoots: [
      ...options.additionalProtectedRoots,
      ...(process.platform === "linux" ? [] : [stateRoot]),
      ...codexSeedSources(request),
    ],
  });
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
  requireCodexRuntimeReadRoots(request, protectedRoots);
  requireUnprotectedExecutables(
    readRoots,
    runtimeExecutableProtection(
      readRoots,
      protectedRoots,
      Boolean(request.runtimePolicy),
    ),
  );
  const profileId = `sevro_${randomUUID().replaceAll("-", "")}`;
  const runtimeProfile = codexRuntimeProfile(runtime);
  await writeCodexProfile(
    paths,
    profileId,
    request,
    readRoots,
    protectedRoots,
    limit,
    runtimeProfile.environment,
    runtimeProfile.root,
  );
  const shellRoot = await fixtureShellRoot(request, paths.parentHome);
  const env = codexEnvironment(paths, request, shellRoot);
  applyCodexRuntime(runtime, env, paths);
  return { ...paths, sandboxBinary, profileId, env, protectedRoots };
}

function requireCodexRuntimeReadRoots(
  request: Request,
  protectedRoots: string[],
): void {
  requireRuntimeReadRoots(
    request.runtimePolicy?.readOnlyRoots ?? [],
    protectedRoots,
  );
}
