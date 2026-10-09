import { runCodexAppServer } from "./codex-app-server";
import { runCodexProcess } from "./codex-process";
import { verifyCodexInvocation } from "./codex-invocation";
import { installCodexPlugins } from "./codex-marketplace";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
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
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import type { HostAdapter, HostResult } from "../engine";
import { codexNativeControls } from "./native-controls";
import { summarizeCodexEvents, type CodexEventSummary } from "./codex-events";
import {
  codexNativeCallObservation,
  codexNativeSkillReadRecovery,
  codexNativeSessionLastOrdinal,
} from "./codex-native-calls";
import { codexSkillReadObservation } from "./codex-skill-reads";
import { codexPermissionProfile } from "./codex-profile";
import { evaluationProtectedRoots } from "./isolation-roots";
import { workspaceFingerprint } from "./workspace-fingerprint";
import {
  requireRuntimeReadRoots,
  runtimeExecutableProtection,
} from "../runtime-paths";
import { prepareRuntimeState, runtimeObservations } from "../runtime-state";
import { runtimeNativeGoalEnabled } from "../runtime-config";
import {
  prepareHookMounts,
  runtimeHookObservation,
  releaseRuntimeHooks,
  type HookMounts,
} from "../runtime-hooks";

const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
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

type Request = Parameters<HostAdapter["run"]>[0];
type ProcessResult = Awaited<ReturnType<typeof runCodexProcess>>;
type AppServerResult = Awaited<ReturnType<typeof runCodexAppServer>>;
type Observation = {
  id: string;
  completeness: "complete" | "partial";
  data: Record<string, unknown>;
};
type CodexState = Awaited<ReturnType<typeof prepareCodexState>>;
interface ExecutionContext {
  options: CodexHostOptions;
  request: Request;
  state: CodexState;
  timeoutMs: number;
  installedPluginRoots: string[];
  hooks?: HookMounts;
}
interface TurnResult {
  execution: ProcessResult;
  summary: CodexEventSummary;
  followUp: ProcessResult | null;
  followUpSummary: CodexEventSummary | null;
  appServer: AppServerResult | null;
  continuation: Observation | undefined;
  observedEvents: string;
}

function validCodexPaths(options: CodexHostOptions): boolean {
  return (
    [
      options.binary,
      options.authFile,
      options.projectRoot,
      options.resultsRoot,
      ...options.additionalProtectedRoots,
    ].every(isAbsolute) &&
    (options.sandboxBinary === undefined || isAbsolute(options.sandboxBinary))
  );
}
function validConcurrencyLimit(limit: number | null): boolean {
  return limit === null || (Number.isSafeInteger(limit) && limit >= 1);
}
function validEntrypoint(entrypoint: CodexHostOptions["entrypoint"]): boolean {
  return (
    entrypoint === undefined || ["exec", "app-server"].includes(entrypoint)
  );
}
function validCodexTimeout(timeoutMs: number): boolean {
  return (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1 &&
    timeoutMs <= MAX_TIMEOUT_MS
  );
}
function validCodexIdentity(
  options: CodexHostOptions,
  limit: number | null,
  timeoutMs: number,
): boolean {
  return (
    !!options.model &&
    !!options.effort &&
    validEntrypoint(options.entrypoint) &&
    validConcurrencyLimit(limit) &&
    validCodexTimeout(timeoutMs)
  );
}
function codexCapabilities(
  entrypoint: CodexHostOptions["entrypoint"],
): string[] {
  return [
    "sevro.host.continuation",
    "sevro.host.runtime",
    "sevro.host.hooks",
    ...(entrypoint === "app-server" ? ["sevro.host.native-goal"] : []),
    "sevro.codex.plugin-marketplace",
    "sevro.codex.explicit-invocation",
    "sevro.codex.repository-invocation",
    "sevro.codex.native-calls",
    "sevro.host.native-controls",
    "sevro.codex.initial-skill-reads",
    "sevro.codex.follow-up-skill-reads",
  ];
}
function codexConfiguration(
  limit: number | null,
  entrypoint: CodexHostOptions["entrypoint"],
) {
  return {
    "sevro.codex.agent-concurrency-limit": limit,
    ...(entrypoint === "app-server"
      ? { "sevro.codex.entrypoint": "app-server" }
      : {}),
  };
}

/** Construct one Codex route without inheriting user settings or credentials. */
export function createCodexHost(options: CodexHostOptions): HostAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.agentConcurrencyLimit ?? null;
  if (
    !validCodexPaths(options) ||
    !validCodexIdentity(options, limit, timeoutMs)
  )
    throw new Error("invalid Codex host configuration");
  return {
    id: "sevro.host.codex",
    hostCapabilities: codexCapabilities(options.entrypoint),
    model: options.model,
    effort: options.effort,
    configuration: codexConfiguration(limit, options.entrypoint),
    run(request) {
      return runCodexRequest(options, timeoutMs, limit, request);
    },
  };
}

function requireCodexFollowUp(request: Request): void {
  if (
    request.followUpPrompt !== undefined &&
    (typeof request.followUpPrompt !== "string" ||
      !request.followUpPrompt.trim())
  )
    throw new Error("Codex follow-up prompt must be nonempty");
}
function requireCodexFixtureBin(request: Request): void {
  if (
    request.fixtureBinDir !== undefined &&
    request.fixtureBinDir !== join(request.workspace, ".git", "fixture-bin")
  )
    throw new Error("fixture binary path is outside the workspace");
}
function requirePassiveCodexRequest(request: Request): void {
  if (request.instrumentation?.length)
    throw new Error("Codex instrumentation is unavailable");
  if (request.condition !== "passive")
    throw new Error("Codex enforcement instrumentation is unavailable");
}
async function runCodexRequest(
  options: CodexHostOptions,
  timeoutMs: number,
  limit: number | null,
  request: Request,
): Promise<HostResult> {
  requireCodexFollowUp(request);
  requireCodexFixtureBin(request);
  requirePassiveCodexRequest(request);
  requireCodexGoalRoute(request, options);
  await verifyCodexInvocation(request);
  if (existsSync(join(request.workspace, ".codex")))
    throw new Error("fixture Codex configuration is unsupported");
  const stateRoot = await mkdtemp(
    join(
      process.platform === "linux" ? "/var/tmp" : tmpdir(),
      "sevro-codex-state-",
    ),
  );
  const helperRoot =
    process.platform === "linux"
      ? await mkdtemp(join(tmpdir(), "sevro-codex-helper-"))
      : undefined;
  let activeHooks: HookMounts | undefined;
  try {
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
    });
    const hooks = await codexHookMounts(request, state, installedPluginRoots);
    activeHooks = hooks;
    await codexPreflight(options, request, state);
    const context: ExecutionContext = {
      options,
      request,
      state,
      timeoutMs,
      installedPluginRoots,
      hooks,
    };
    const turns = await new CodexTurnExecution(context).run();
    return await codexHostResult(context, turns);
  } finally {
    await releaseRuntimeHooks(activeHooks);
    await rm(stateRoot, { recursive: true, force: true });
    if (helperRoot) await rm(helperRoot, { recursive: true, force: true });
  }
}

function requireCodexGoalRoute(
  request: Request,
  options: CodexHostOptions,
): void {
  if (
    runtimeNativeGoalEnabled(request.runtimePolicy) &&
    options.entrypoint !== "app-server"
  )
    throw new Error("native-goal runtime policy requires Codex app-server");
}

async function codexHookMounts(
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
    commandEnvironment: codexCommandEnvironment(request, commandEnvironment),
    runtimeWriteRoot,
    runtimeReadRoots: [
      ...(request.runtimePolicy?.readOnlyRoots ?? []),
      ...linuxArg0ReadRoots(paths.codexHome),
    ],
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
) {
  if (!request.runtimePolicy) return undefined;
  const runtime = await prepareRuntimeState(
    request.workspace,
    request.runtimePolicy,
    request.runtimeRole ?? "candidate",
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
async function prepareCodexState(
  stateRoot: string,
  options: CodexHostOptions,
  limit: number | null,
  request: Request,
  helperRoot?: string,
) {
  const paths = await privateCodexDirectories(stateRoot);
  const runtime = await codexRuntime(request, paths);
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
) {
  return runCodexProcess({
    argv: sandboxArgs(state, request, command),
    cwd: request.workspace,
    env: state.env,
    timeoutMs: 10_000,
    signal: request.signal,
  });
}
async function codexPreflight(
  options: CodexHostOptions,
  request: Request,
  state: CodexState,
): Promise<void> {
  const probe = join(state.commandTemp, "isolation-probe");
  await writeFile(probe, "probe\n", { flag: "wx", mode: 0o600 });
  const checked = await sandboxPreflight(state, request, [
    "/bin/sh",
    "-c",
    '/bin/cat "$1" >/dev/null && ! /bin/ls "$2" >/dev/null 2>&1 && ! /bin/cat "$3" >/dev/null 2>&1 && ! /bin/cat "$4" >/dev/null 2>&1',
    "sevro-probe",
    probe,
    options.projectRoot,
    join(state.codexHome, "auth.json"),
    join(state.codexHome, "config.toml"),
  ]);
  if (checked.code !== 0) throw new Error("Codex isolation preflight failed");
  const executable = await sandboxPreflight(state, request, [
    state.sandboxBinary,
    "--version",
  ]);
  if (executable.code !== 0)
    throw new Error("Codex executable preflight failed");
  await rm(probe);
}

function routeArgs(context: ExecutionContext): string[] {
  return [
    "-m",
    context.options.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(context.options.effort)}`,
    "-c",
    `default_permissions=${JSON.stringify(context.state.profileId)}`,
    "-c",
    'approval_policy="never"',
    "-c",
    `features.hooks=${Boolean(context.hooks)}`,
  ];
}
function initialTurnArgs(context: ExecutionContext): string[] {
  return [
    context.options.binary,
    "exec",
    "--json",
    "--strict-config",
    "--skip-git-repo-check",
    ...(context.request.followUpPrompt ? [] : ["--ephemeral"]),
    "--ignore-rules",
    ...(context.hooks ? ["--dangerously-bypass-hook-trust"] : []),
    "-C",
    context.request.workspace,
    ...routeArgs(context),
    "-",
  ];
}
function followUpTurnArgs(
  context: ExecutionContext,
  threadId: string,
): string[] {
  return [
    context.options.binary,
    "exec",
    "resume",
    "--json",
    "--strict-config",
    "--skip-git-repo-check",
    "--ignore-rules",
    ...(context.hooks ? ["--dangerously-bypass-hook-trust"] : []),
    ...routeArgs(context),
    threadId,
    "-",
  ];
}
async function codexProcessTurn(
  context: ExecutionContext,
  argv: string[],
  input: string,
): Promise<ProcessResult> {
  return runCodexProcess({
    argv,
    cwd: context.request.workspace,
    env: context.state.env,
    input,
    timeoutMs: context.timeoutMs,
    signal: context.request.signal,
  });
}
async function initialFingerprint(request: Request): Promise<string | null> {
  return request.followUpPrompt
    ? workspaceFingerprint(request.workspace)
    : null;
}
async function continuationBoundary(
  context: ExecutionContext,
  threadId: string,
  originalFingerprint: string | null,
  goal: Record<string, unknown> = {},
): Promise<Observation> {
  const boundary = await workspaceFingerprint(context.request.workspace);
  const measured = originalFingerprint !== null && boundary !== null;
  return {
    id: "sevro.codex.continuation",
    completeness: measured ? "complete" : "partial",
    data: {
      method: "same_thread_resume",
      ...goal,
      threadId,
      nativeAfterOrdinal: await codexNativeSessionLastOrdinal(
        context.state.codexHome,
        threadId,
      ),
      preFollowUpWorktreeUnchanged: measured
        ? originalFingerprint === boundary
        : null,
    },
  };
}
function requireInitialCompletion(
  summary: CodexEventSummary,
  appServer: AppServerResult | null,
): void {
  if (!summary.complete && !appServer)
    throw new Error("Codex turn did not complete");
}
function requireFollowUpCompletion(
  followUp: CodexEventSummary,
  original: CodexEventSummary,
): void {
  if (!followUp.complete || followUp.threadId !== original.threadId)
    throw new Error(
      "Codex follow-up turn did not complete in the original thread",
    );
}
async function appServerSummary(
  result: AppServerResult,
  workspace: string,
): Promise<CodexEventSummary> {
  return {
    threadId: result.evidence.threadId ?? "",
    complete: result.code === 0,
    finalMessage:
      result.code === 0
        ? await readFile(join(workspace, ".git", "last-message.md"), "utf8")
        : null,
    inputTokens: null,
    outputTokens: null,
    usageComplete: false,
  };
}
async function initialSummary(
  appServer: AppServerResult | null,
  execution: ProcessResult,
  request: Request,
): Promise<CodexEventSummary> {
  return appServer
    ? appServerSummary(appServer, request.workspace)
    : summarizeCodexEvents(execution.out, execution.code);
}
function combinedEvents(
  execution: ProcessResult,
  followUp: ProcessResult | null,
): string {
  const out = followUp
    ? `${execution.out.trimEnd()}\n${followUp.out.trimStart()}`
    : execution.out;
  if (Buffer.byteLength(out, "utf8") > MAX_EVENT_BYTES)
    throw new Error("Codex combined event stream exceeds the size limit");
  return out;
}

class CodexTurnExecution {
  private appServerContinuation?: Observation;
  constructor(private context: ExecutionContext) {}
  async run(): Promise<TurnResult> {
    const fingerprint = await initialFingerprint(this.context.request);
    const appServer = await this.maybeAppServer(fingerprint);
    const execution =
      appServer ??
      (await codexProcessTurn(
        this.context,
        initialTurnArgs(this.context),
        this.context.request.prompt,
      ));
    const summary = await initialSummary(
      appServer,
      execution,
      this.context.request,
    );
    requireInitialCompletion(summary, appServer);
    const follow = await this.maybeFollowUp(summary, appServer, fingerprint);
    return {
      execution,
      summary,
      appServer,
      ...follow,
      observedEvents: combinedEvents(execution, follow.followUp),
    };
  }

  private async maybeAppServer(
    fingerprint: string | null,
  ): Promise<AppServerResult | null> {
    const { options, request, state, timeoutMs } = this.context;
    if (options.entrypoint !== "app-server") return null;
    return runCodexAppServer({
      argv: [
        options.binary,
        "app-server",
        "--stdio",
        "--strict-config",
        "-c",
        `default_permissions=${JSON.stringify(state.profileId)}`,
        "-c",
        `features.hooks=${Boolean(this.context.hooks)}`,
      ],
      env: state.env,
      permissionProfile: state.profileId,
      vettedHooks: Boolean(this.context.hooks),
      request: {
        repoDir: request.workspace,
        prompt: request.prompt,
        model: options.model,
        effort: options.effort,
        signal: request.signal,
        control: {
          appServerTimeoutMs: timeoutMs,
          ...(request.followUpPrompt
            ? { followUpPrompt: request.followUpPrompt }
            : {}),
        },
      },
      followUpBoundary: async (threadId, goal) => {
        this.appServerContinuation = await continuationBoundary(
          this.context,
          threadId,
          fingerprint,
          goal,
        );
        return JSON.stringify({
          type: "sevro.codex.feedback-boundary",
          ...this.appServerContinuation.data,
        });
      },
    });
  }

  private async maybeFollowUp(
    summary: CodexEventSummary,
    appServer: AppServerResult | null,
    fingerprint: string | null,
  ) {
    const prompt = this.context.request.followUpPrompt;
    if (!prompt || appServer)
      return {
        followUp: null,
        followUpSummary: null,
        continuation: this.appServerContinuation,
      };
    const continuation = await continuationBoundary(
      this.context,
      summary.threadId,
      fingerprint,
    );
    const followUp = await codexProcessTurn(
      this.context,
      followUpTurnArgs(this.context, summary.threadId),
      prompt,
    );
    const followUpSummary = summarizeCodexEvents(followUp.out, followUp.code);
    requireFollowUpCompletion(followUpSummary, summary);
    return { followUp, followUpSummary, continuation };
  }
}

type SkillReads = Awaited<ReturnType<typeof codexSkillReadObservation>>;
async function phaseSkillReads(
  context: ExecutionContext,
  turns: TurnResult,
  recovered: Awaited<ReturnType<typeof codexNativeSkillReadRecovery>>,
) {
  if (!turns.followUp) return { initial: null, followUp: null };
  const initial = {
    ...(await codexSkillReadObservation(
      turns.execution.out,
      context.request.workspace,
      context.installedPluginRoots,
      recovered,
    )),
    id: "sevro.codex.initial-skill-reads",
  };
  const followUp = {
    ...(await codexSkillReadObservation(
      turns.followUp.out,
      context.request.workspace,
      context.installedPluginRoots,
      recovered,
    )),
    id: "sevro.codex.follow-up-skill-reads",
  };
  return { initial, followUp };
}
function explicitInvocationReceipt(
  selected: Request["explicitSkillInvocation"],
  reads: SkillReads,
) {
  if (!selected) return null;
  return {
    id: "sevro.codex.explicit-invocation",
    completeness: reads.completeness,
    data: {
      method: "explicit_invocation",
      primarySkill: selected.skillName,
      observedSkills: [
        selected.skillName,
        ...reads.data.observedSkills.filter(
          (skill) => skill !== selected.skillName,
        ),
      ],
    },
  };
}
function nativeSkillContext(context: ExecutionContext) {
  return {
    workspace: context.request.workspace,
    installedPluginRoots: context.installedPluginRoots,
    ...(context.request.followUpPrompt
      ? { followUpPrompt: context.request.followUpPrompt }
      : {}),
  };
}
function appServerObservation(result: AppServerResult | null): Observation[] {
  return result
    ? [
        {
          id: "sevro.host.native-goal",
          completeness: result.code === 0 ? "complete" : "partial",
          data: { ...result.evidence },
        },
      ]
    : [];
}
async function codexObservations(context: ExecutionContext, turns: TurnResult) {
  const recovered = await codexNativeSkillReadRecovery(
    context.state.codexHome,
    turns.summary.threadId,
  );
  const reads = await codexSkillReadObservation(
    turns.observedEvents,
    context.request.workspace,
    context.installedPluginRoots,
    recovered,
  );
  const phases = await phaseSkillReads(context, turns, recovered);
  const native = await codexNativeCallObservation(
    context.state.codexHome,
    turns.summary.threadId,
    nativeSkillContext(context),
  );
  const explicit = explicitInvocationReceipt(
    context.request.explicitSkillInvocation,
    reads,
  );
  return [
    ...(await codexHookObservations(context.hooks)),
    ...runtimeObservations(
      context.request.runtimePolicy,
      context.request.runtimeRole,
    ),
    ...appServerObservation(turns.appServer),
    reads,
    ...(phases.initial ? [phases.initial] : []),
    ...(phases.followUp ? [phases.followUp] : []),
    native,
    codexNativeControls(native),
    ...(turns.continuation ? [turns.continuation] : []),
    ...(explicit ? [explicit] : []),
  ];
}

async function codexHookObservations(hooks: HookMounts | undefined) {
  return hooks ? [await runtimeHookObservation(hooks)] : [];
}
function codexArtifacts(turns: TurnResult) {
  return [
    {
      id: "sevro.codex.events",
      bytes: Buffer.from(turns.execution.out, "utf8"),
    },
    ...(turns.followUp
      ? [
          {
            id: "sevro.codex.follow-up-events",
            bytes: Buffer.from(turns.followUp.out, "utf8"),
          },
        ]
      : []),
  ];
}
function tokenCount(
  initial: number | null,
  followUp: number | null | undefined,
): number | null {
  if (followUp === undefined) return initial;
  return initial !== null && followUp !== null ? initial + followUp : null;
}
function codexUsageComplete(
  summary: CodexEventSummary,
  followUp: CodexEventSummary | null,
): boolean {
  return summary.usageComplete && (followUp?.usageComplete ?? true);
}
function codexUsage(turns: TurnResult) {
  return {
    inputTokens: tokenCount(
      turns.summary.inputTokens,
      turns.followUpSummary?.inputTokens,
    ),
    outputTokens: tokenCount(
      turns.summary.outputTokens,
      turns.followUpSummary?.outputTokens,
    ),
    usageComplete: codexUsageComplete(turns.summary, turns.followUpSummary),
    costUsd: null,
  };
}
async function codexHostResult(
  context: ExecutionContext,
  turns: TurnResult,
): Promise<HostResult> {
  const final = turns.followUpSummary ?? turns.summary;
  return {
    finalMessage: final.finalMessage,
    ...(turns.appServer ? { executionFailed: !turns.summary.complete } : {}),
    complete: final.finalMessage !== null,
    observations: await codexObservations(context, turns),
    artifacts: codexArtifacts(turns),
    actualCondition: "passive",
    ...codexUsage(turns),
  };
}
