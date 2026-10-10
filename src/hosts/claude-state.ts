import {
  cp,
  mkdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { HostAdapter } from "../engine";
import { nativeStateParent } from "../native-transcript-state";
import {
  candidateTranscriptEnvironment,
  candidateTranscriptRoots,
} from "../native-transcripts";
import { prepareHookMounts, runtimeHooksEnabled } from "../runtime-hooks";
import {
  insideRuntimeRoot as inside,
  runtimeExecutableProtection,
} from "../runtime-paths";
import { prepareRuntimeState } from "../runtime-state";
import { stageClaudeAuthentication } from "./claude-credential";
import { claudeHostSettings } from "./claude-settings";
import { evaluationProtectedRoots } from "./isolation-roots";
type Request = Parameters<HostAdapter["run"]>[0];
export interface ClaudeHostOptions {
  binary: string;
  model: string;
  effort: string;
  projectRoot: string;
  resultsRoot: string;
  additionalProtectedRoots: string[];
  credentialFile?: string;
  uvCacheDir?: string;
  toolchainBinDir?: string;
  projectSettings?: boolean;
  timeoutMs?: number;
}

function minimalRoots(roots: string[]): string[] {
  return roots.filter(
    (root) => !roots.some((other) => other !== root && inside(other, root)),
  );
}

function runtimeSeedSources(request: Request): string[] {
  return (request.runtimePolicy?.seeds ?? []).map((seed) => seed.source);
}

async function createClaudePrivateState(
  stateRoot: string,
  options: ClaudeHostOptions,
) {
  await mkdir(join(stateRoot, "private"), { mode: 0o700 });
  const privateRoot = await realpath(join(stateRoot, "private"));
  const home = join(stateRoot, "home"),
    temp = join(stateRoot, "tmp");
  await Promise.all([home, temp].map((path) => mkdir(path, { mode: 0o700 })));
  const authentication = await stageClaudeAuthentication(
    join(privateRoot, "config"),
    options.credentialFile,
  );
  return {
    privateRoot,
    home,
    temp,
    authentication,
    credential: authentication.credentialFile,
  };
}

async function protectedClaudeRoots(
  request: Request,
  options: ClaudeHostOptions,
  credential: string,
) {
  const candidates = await evaluationProtectedRoots({
    ownedStateRoot: dirname(dirname(dirname(credential))),
    workspace: request.workspace,
    projectRoot: options.projectRoot,
    resultsRoot: options.resultsRoot,
    additionalRoots: [
      ...options.additionalProtectedRoots,
      ...runtimeSeedSources(request),
    ],
  });
  const roots = request.runtimePolicy ? candidates : minimalRoots(candidates);
  const namespace = await nativeStateParent();
  if (roots.some((root) => root !== namespace && inside(root, credential)))
    throw new Error("Claude private state overlaps a protected root");
  const binary = await realpath(options.binary);
  const executableRoots = runtimeExecutableProtection(
    [dirname(binary)],
    roots,
    Boolean(request.runtimePolicy),
  );
  if (executableRoots.some((root) => inside(root, binary)))
    throw new Error("Claude executable resides inside a protected root");
  return roots;
}

async function claudeToolchainDirectory(
  options: ClaudeHostOptions,
  roots: string[],
): Promise<string | null> {
  const directory = options.toolchainBinDir
    ? await realpath(options.toolchainBinDir)
    : null;
  if (
    directory &&
    (roots.some((root) => inside(root, directory)) ||
      !(await stat(directory)).isDirectory())
  )
    throw new Error("Claude toolchain directory is unavailable or protected");
  return directory;
}

async function prepareClaudeRuntime(
  options: ClaudeHostOptions,
  roots: string[],
  workspace: string,
): Promise<string | null> {
  if (!options.uvCacheDir) return null;
  const cache = await realpath(options.uvCacheDir);
  if (
    roots.some((root) => inside(root, cache)) ||
    !(await stat(cache)).isDirectory()
  )
    throw new Error("Claude UV cache is unavailable or protected");
  const runtimeRoot = join(workspace, ".git", "sevro-runtime");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await cp(cache, join(runtimeRoot, "uv-cache"), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  return runtimeRoot;
}

function claudeEnvironment(
  state: Awaited<ReturnType<typeof createClaudePrivateState>>,
  request: Request,
  toolchain: string | null,
  runtime: string | null,
): Record<string, string> {
  return {
    ...state.authentication.environment,
    ...request.runtimePolicy?.environment,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    PATH: claudePath(request, toolchain),
    LANG: process.env.LANG ?? "C",
    HOME: runtime ? join(runtime, "host-home") : state.home,
    TMPDIR: state.temp,
    CLAUDE_CONFIG_DIR: dirname(state.credential),
    NO_COLOR: "1",
    ...claudeRuntimeEnvironment(runtime),
  };
}

function claudePath(request: Request, toolchain: string | null): string {
  const path =
    request.runtimePolicy?.environment.PATH ??
    process.env.PATH ??
    "/usr/bin:/bin";
  return [request.fixtureBinDir, toolchain, path]
    .filter(Boolean)
    .join(delimiter);
}

function claudeRuntimeEnvironment(
  runtime: string | null,
): Record<string, string> {
  return runtime
    ? {
        UV_CACHE_DIR: join(runtime, "uv-cache"),
        UV_PROJECT_ENVIRONMENT: join(runtime, "project-environment"),
        UV_OFFLINE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      }
    : {};
}

export async function prepareClaudeState(
  stateRoot: string,
  options: ClaudeHostOptions,
  request: Request,
  pluginDirs: string[],
) {
  await requireClaudeRuntimeNamespace(request, stateRoot);
  const state = await createClaudePrivateState(stateRoot, options);
  const transcripts = await claudeTranscriptAccess(
    stateRoot,
    state.credential,
    request,
  );
  const roots = await protectedClaudeRoots(request, options, state.credential);
  const toolchain = await claudeToolchainDirectory(options, roots);
  const runtime = await prepareClaudeRuntime(options, roots, request.workspace);
  const settingsPath = join(state.privateRoot, "settings.json");
  const hooks = await claudeHookMounts(
    request,
    stateRoot,
    state.privateRoot,
    pluginDirs,
    roots,
  );
  const effectivePlugins = hooks?.directories ?? pluginDirs;
  const env = claudeEnvironment(state, request, toolchain, runtime);
  const runtimeWriteRoot = await applyClaudeRuntimeEnvironment(
    request,
    env,
    runtime,
    stateRoot,
  );
  await writeFile(
    settingsPath,
    JSON.stringify(
      claudeHostSettings(
        state.privateRoot,
        state.credential,
        [...pluginDirs, ...effectivePlugins],
        roots,
        transcripts.policy,
        [
          ...transcripts.readRoots,
          ...candidateTranscriptRoots(request.candidateTranscriptRoot),
        ],
        runtimeWriteRoot
          ? { root: runtimeWriteRoot, workspace: request.workspace }
          : undefined,
      ),
    ),
    { flag: "wx", mode: 0o600 },
  );
  Object.assign(env, transcripts.environment);
  Object.assign(
    env,
    candidateTranscriptEnvironment(request.candidateTranscriptRoot),
  );
  if (runtime) await mkdir(join(runtime, "host-home"), { mode: 0o700 });
  return {
    credential: state.credential,
    settingsPath,
    env,
    hooks,
    pluginDirs: effectivePlugins,
  };
}

/** Claude's implicit /tmp/claude writes cannot contain the read-denied peer namespace. */
async function requireClaudeRuntimeNamespace(
  request: Request,
  stateRoot: string,
) {
  if (!request.runtimePolicy) return;
  const implicitRoots = await Promise.all(
    ["/tmp/claude", "/private/tmp/claude"].map(implicitClaudeWritePaths),
  );
  const namespace = dirname(stateRoot);
  if (
    implicitRoots
      .flat()
      .some((root) => inside(root, namespace) || inside(namespace, root))
  )
    throw new Error(
      "Claude namespace overlaps an implicit native writable root",
    );
}

async function implicitClaudeWritePaths(root: string): Promise<string[]> {
  try {
    return [root, await realpath(root)];
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Claude implicit native writable root is unreadable", {
        cause,
      });
    return [root];
  }
}

async function claudeTranscriptAccess(
  stateRoot: string,
  credential: string,
  request: Request,
) {
  const policy = request.runtimePolicy;
  if (!policy?.nativeTranscripts)
    return { policy, environment: {}, readRoots: [] };
  const view = join(stateRoot, "native-home");
  const projects = join(view, "projects");
  await mkdir(projects, { recursive: true, mode: 0o700 });
  await symlink(projects, join(dirname(credential), "projects"));
  const startup = join(view, "shell-env");
  const script = `export CLAUDE_CONFIG_DIR='${view.replaceAll("'", `'"'"'`)}'\n`;
  await writeFile(startup, script, { flag: "wx", mode: 0o600 });
  await writeFile(join(view, ".zshenv"), script, { flag: "wx", mode: 0o600 });
  return {
    policy,
    readRoots: [projects, view],
    environment: {
      SEVRO_NATIVE_TRANSCRIPT_ROOT: projects,
      BASH_ENV: startup,
      ZDOTDIR: view,
    },
  };
}

async function claudeHookMounts(
  request: Request,
  stateRoot: string,
  privateRoot: string,
  pluginDirs: string[],
  roots: string[],
) {
  const policy = request.runtimePolicy;
  if (!policy || !runtimeHooksEnabled(policy)) return undefined;
  return prepareHookMounts({
    workspace: request.workspace,
    stateRoot,
    privateRoot,
    pluginRoots: pluginDirs,
    protectedRoots: [
      privateRoot,
      ...roots,
      ...(policy.seeds ?? []).map((seed) => seed.source),
    ],
    policy,
  });
}

async function applyClaudeRuntimeEnvironment(
  request: Request,
  env: Record<string, string>,
  runtime: string | null,
  stateRoot: string,
): Promise<string | undefined> {
  const isolated = await prepareRuntimeState(
    request.workspace,
    claudeCommandPolicy(request),
    request.runtimeRole ?? "candidate",
    claudeRuntimeDirectory(request, stateRoot),
  );
  if (request.runtimePolicy) {
    Object.assign(env, isolated.environment);
    env.PATH = [request.fixtureBinDir, isolated.environment.PATH ?? env.PATH]
      .filter(Boolean)
      .join(delimiter);
    return isolated.root;
  }
  applyLegacyClaudeCommandEnvironment(env, isolated, runtime);
  return undefined;
}

function claudeRuntimeDirectory(request: Request, stateRoot: string) {
  return request.runtimePolicy ? join(stateRoot, "runtime") : undefined;
}

function applyLegacyClaudeCommandEnvironment(
  env: Record<string, string>,
  isolated: Awaited<ReturnType<typeof prepareRuntimeState>>,
  runtime: string | null,
): void {
  if (!runtime) env.HOME = isolated.home;
  env.TMPDIR = isolated.temp;
}

function claudeCommandPolicy(request: Request) {
  return (
    request.runtimePolicy ?? {
      format: "sevro.runtime.v1" as const,
      environment: {},
      readOnlyRoots: [],
    }
  );
}
