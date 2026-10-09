import { isRecord } from "../value-guards";
import {
  retainEnabledNativeTranscripts,
  failedNativeTranscripts,
  candidateTranscriptRoots,
  candidateTranscriptEnvironment,
} from "../native-transcripts";
import {
  allocateNativeState,
  nativeStateParent,
  requireNativeTranscriptView,
} from "../native-transcript-state";
import { runClaudeProcess } from "./claude-process";
import { observeClaudeNativeGoal } from "./claude-native-goal";
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
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HostAdapter, HostResult } from "../engine";
import { claudeNativeControls } from "./native-controls";
import { fixtureParts } from "../preparation";
import { stageClaudeAuthentication } from "./claude-credential";
import { summarizeClaudeEvents } from "./claude-events";
import { claudeNestedSkillsObservation } from "./claude-nested-skills";
import {
  claudeRepositoryInvocationObservation,
  verifyClaudeRepositoryInvocation,
} from "./claude-repository-invocation";
import { claudeHostSettings } from "./claude-settings";
import { claudeToolCallsObservation } from "./claude-tool-calls";
import { evaluationProtectedRoots } from "./isolation-roots";
import { prepareRuntimeState, runtimeObservations } from "../runtime-state";
import { runtimeExecutableProtection } from "../runtime-paths";
import {
  prepareHookMounts,
  runtimeHookObservation,
  runtimeHooksEnabled,
  releaseRuntimeHooks,
  type HookMounts,
} from "../runtime-hooks";
import { runClaudeTurns, type ClaudeSession } from "./claude-continuation";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

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

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function minimalRoots(roots: string[]): string[] {
  return roots.filter(
    (root) => !roots.some((other) => other !== root && inside(other, root)),
  );
}

type Request = Parameters<HostAdapter["run"]>[0];
function runtimeSeedSources(request: Request): string[] {
  return (request.runtimePolicy?.seeds ?? []).map((seed) => seed.source);
}
type PluginDeclaration = NonNullable<Request["claudePluginDirs"]>;
type PluginInvocation = NonNullable<Request["explicitSkillInvocation"]> & {
  scope?: "plugin";
};
type RepositoryInvocation = Awaited<
  ReturnType<typeof verifyClaudeRepositoryInvocation>
>;
type Execution = Awaited<ReturnType<typeof runClaudeTurns>>;

async function pluginDirectories(
  workspace: string,
  declaration: PluginDeclaration,
): Promise<string[]> {
  const root = await realpath(workspace);
  requireUniquePluginDeclaration(declaration);
  const paths = new Set(declaration.artifactPaths);
  const directories: string[] = [];
  for (const relativeRoot of declaration.artifactRoots)
    directories.push(await declaredPluginDirectory(root, relativeRoot, paths));
  requireDisjointPluginDirectories(directories);
  for (const artifactPath of paths)
    await verifyPluginArtifact(root, artifactPath, declaration, directories);
  return directories;
}

function requireUniquePluginDeclaration(declaration: PluginDeclaration): void {
  if (
    new Set(declaration.artifactRoots).size !==
      declaration.artifactRoots.length ||
    new Set(declaration.artifactPaths).size !== declaration.artifactPaths.length
  )
    throw new Error("Claude plugin declaration contains duplicates");
}

async function declaredPluginDirectory(
  root: string,
  relativeRoot: string,
  paths: Set<string>,
): Promise<string> {
  fixtureParts(relativeRoot);
  if (!paths.has(`${relativeRoot}/.claude-plugin/plugin.json`))
    throw new Error("Claude plugin manifest is undeclared");
  const actual = await realpath(join(root, relativeRoot));
  if (!inside(root, actual))
    throw new Error("Claude plugin directory escapes workspace");
  if (!(await stat(join(actual, ".claude-plugin", "plugin.json"))).isFile())
    throw new Error("Claude plugin manifest is missing");
  return actual;
}

function requireDisjointPluginDirectories(directories: string[]): void {
  if (new Set(directories).size !== directories.length)
    throw new Error("Claude plugin directories overlap");
  if (
    directories.some((item) =>
      directories.some((other) => item !== other && inside(other, item)),
    )
  )
    throw new Error("Claude plugin directories overlap");
}

async function verifyPluginArtifact(
  root: string,
  artifactPath: string,
  declaration: PluginDeclaration,
  directories: string[],
): Promise<void> {
  fixtureParts(artifactPath);
  const index = declaration.artifactRoots.findIndex((item) =>
    artifactPath.startsWith(`${item}/`),
  );
  const directory = directories.at(index);
  if (index < 0 || directory === undefined)
    throw new Error("Claude plugin artifact is outside a declared directory");
  if (!inside(directory, await realpath(join(root, artifactPath))))
    throw new Error("Claude plugin artifact escapes workspace");
}

function pluginSelection(request: Request): PluginInvocation | null {
  const selected = request.explicitSkillInvocation;
  if (!selected || selected.scope === "repository") return null;
  return selected;
}

function requirePluginInvocation(
  selected: PluginInvocation,
  prompt: string,
): void {
  const { token, pluginName, skillName } = selected;
  if (
    token !== `/${pluginName}:${skillName}` ||
    prompt.split(token).length - 1 !== 1 ||
    !/^[a-z][a-z0-9-]*$/.test(pluginName) ||
    !/^[A-Za-z0-9._-]+$/.test(skillName)
  )
    throw new Error("invalid Claude explicit skill invocation");
}

function skillPathDeclared(
  request: Request,
  index: number,
  skillName: string,
): boolean {
  const relativeRoot = request.claudePluginDirs?.artifactRoots[index];
  return !!request.claudePluginDirs?.artifactPaths.includes(
    `${relativeRoot}/skills/${skillName}/SKILL.md`,
  );
}

async function verifyInvocation(
  request: Request,
  directories: string[],
): Promise<void> {
  const selected = pluginSelection(request);
  if (!selected) return;
  requirePluginInvocation(selected, request.prompt);
  for (const [index, root] of directories.entries()) {
    if (!skillPathDeclared(request, index, selected.skillName)) continue;
    if (await mountedPluginSkill(root, selected)) return;
  }
  throw new Error("invoked Claude skill is absent from the package");
}

async function mountedPluginSkill(
  root: string,
  selected: PluginInvocation,
): Promise<boolean> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"),
    );
  } catch (error) {
    throw new Error("invalid Claude plugin manifest", { cause: error });
  }
  if (!isRecord(manifest) || manifest.name !== selected.pluginName)
    return false;
  const skill = await stat(
    join(root, "skills", selected.skillName, "SKILL.md"),
  ).catch(() => null);
  return !!skill?.isFile();
}

function validClaudeOptions(
  options: ClaudeHostOptions,
  timeoutMs: number,
): boolean {
  return (
    availableClaudeSandbox() &&
    requiredClaudePaths(options) &&
    optionalClaudePaths(options) &&
    !!options.model &&
    validClaudeEffortTimeout(options.effort, timeoutMs)
  );
}
function availableClaudeSandbox(): boolean {
  if (process.platform === "darwin") return existsSync("/usr/bin/sandbox-exec");
  return (
    process.platform === "linux" &&
    existsSync("/usr/bin/bwrap") &&
    existsSync("/usr/bin/socat")
  );
}
function requiredClaudePaths(options: ClaudeHostOptions): boolean {
  return [
    options.binary,
    options.projectRoot,
    options.resultsRoot,
    ...options.additionalProtectedRoots,
  ].every(isAbsolute);
}
function optionalClaudePaths(options: ClaudeHostOptions): boolean {
  return [
    options.credentialFile,
    options.uvCacheDir,
    options.toolchainBinDir,
  ].every((path) => path === undefined || isAbsolute(path));
}
function validClaudeEffortTimeout(effort: string, timeoutMs: number): boolean {
  return (
    !!effort &&
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1 &&
    timeoutMs <= 30 * 60_000
  );
}

/** Run Claude with explicit plugins and its native tool sandbox. */
export function createClaudeHost(options: ClaudeHostOptions): HostAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!validClaudeOptions(options, timeoutMs))
    throw new Error("invalid Claude host configuration");
  return {
    id: "sevro.host.claude",
    model: options.model,
    effort: options.effort,
    hostCapabilities: [
      "sevro.host.native-goal",
      "sevro.host.runtime",
      "sevro.host.native-transcripts",
      "sevro.host.hooks",
      "sevro.claude.plugin-dirs",
      "sevro.claude.explicit-invocation",
      ...(options.projectSettings
        ? ["sevro.claude.repository-invocation"]
        : []),
      "sevro.claude.tool-calls",
      "sevro.host.native-controls",
      "sevro.claude.nested-skills",
      "sevro.host.continuation",
      "sevro.claude.continuation",
    ],
    run(request) {
      return runClaudeRequest(options, timeoutMs, request);
    },
  };
}

function requireClaudeFollowUp(request: Request): void {
  if (
    request.followUpPrompt !== undefined &&
    (typeof request.followUpPrompt !== "string" ||
      !request.followUpPrompt.trim())
  )
    throw new Error("Claude follow-up prompt must be nonempty");
}
function requirePassiveClaudeRequest(request: Request): void {
  if (request.instrumentation?.length || request.condition !== "passive")
    throw new Error("Claude enforcement instrumentation is unavailable");
  requireClaudeFixtureBin(request);
}

function requireClaudeFixtureBin(request: Request): void {
  if (
    request.fixtureBinDir !== undefined &&
    request.fixtureBinDir !== join(request.workspace, ".git", "fixture-bin")
  )
    throw new Error("fixture binary path is outside the workspace");
}

async function repositoryMount(
  request: Request,
  options: ClaudeHostOptions,
): Promise<RepositoryInvocation | null> {
  if (request.explicitSkillInvocation?.scope !== "repository") return null;
  if (!options.projectSettings)
    throw new Error(
      "Claude repository invocation requires project setting sources",
    );
  return verifyClaudeRepositoryInvocation(request);
}

async function runClaudeRequest(
  options: ClaudeHostOptions,
  timeoutMs: number,
  request: Request,
): Promise<HostResult> {
  requireClaudeFollowUp(request);
  await requireNativeTranscriptView(request.candidateTranscriptRoot);
  requirePassiveClaudeRequest(request);
  const pluginDirs = request.claudePluginDirs
    ? await pluginDirectories(request.workspace, request.claudePluginDirs)
    : [];
  await verifyInvocation(request, pluginDirs);
  requireIsolatedHookSources(request, options);
  const repositoryInvocation = await repositoryMount(request, options);
  const stateRoot = await allocateNativeState("claude-");
  let hooks: HookMounts | undefined;
  try {
    const state = await prepareClaudeState(
      stateRoot,
      options,
      request,
      pluginDirs,
    );
    hooks = state.hooks;
    const run = (prompt: string, session?: ClaudeSession) =>
      runClaudeProcess({
        argv: claudeTurnArgs(
          options,
          prompt,
          session,
          state.settingsPath,
          state.pluginDirs,
        ),
        cwd: request.workspace,
        env: state.env,
        timeoutMs,
        signal: request.signal,
      });
    const execution = await runClaudeTurns({
      prompt: request.prompt,
      followUpPrompt: request.followUpPrompt,
      workspace: request.workspace,
      run,
    });
    const result = await claudeResult(
      execution,
      claudeObservationRoot(stateRoot, state.credential, request),
      request,
      repositoryInvocation,
    );
    await addHookObservation(result, state.hooks);
    await retainEnabledNativeTranscripts(
      result,
      request.runtimePolicy,
      join(stateRoot, "native-home", "projects"),
      "claude",
      request.runtimeRole,
    );
    return result;
  } catch (cause) {
    return await failedNativeTranscripts(
      cause,
      request.runtimePolicy,
      join(stateRoot, "native-home", "projects"),
      "claude",
      request.runtimeRole,
    );
  } finally {
    await releaseRuntimeHooks(hooks);
    await rm(stateRoot, { recursive: true, force: true });
  }
}

function requireIsolatedHookSources(
  request: Request,
  options: ClaudeHostOptions,
): void {
  if (runtimeHooksEnabled(request.runtimePolicy) && options.projectSettings)
    throw new Error("native goals require isolated hook sources");
}

async function addHookObservation(
  result: HostResult,
  hooks: Awaited<ReturnType<typeof prepareHookMounts>> | undefined,
): Promise<void> {
  if (!hooks) return;
  result.observations?.push(await runtimeHookObservation(hooks));
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

async function prepareClaudeState(
  stateRoot: string,
  options: ClaudeHostOptions,
  request: Request,
  pluginDirs: string[],
) {
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
      ),
    ),
    { flag: "wx", mode: 0o600 },
  );
  const env = claudeEnvironment(state, request, toolchain, runtime);
  await applyClaudeRuntimeEnvironment(request, env, runtime);
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
): Promise<void> {
  const isolated = await prepareRuntimeState(
    request.workspace,
    claudeCommandPolicy(request),
    request.runtimeRole ?? "candidate",
  );
  if (request.runtimePolicy) {
    Object.assign(env, isolated.environment);
    env.PATH = [request.fixtureBinDir, isolated.environment.PATH ?? env.PATH]
      .filter(Boolean)
      .join(delimiter);
  } else {
    if (!runtime) env.HOME = isolated.home;
    env.TMPDIR = isolated.temp;
  }
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

function claudeTurnArgs(
  options: ClaudeHostOptions,
  prompt: string,
  session: ClaudeSession | undefined,
  settingsPath: string,
  pluginDirs: string[],
): string[] {
  return [
    options.binary,
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    "--effort",
    options.effort,
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Bash,Read,Edit,Skill,Agent",
    "--setting-sources",
    options.projectSettings ? "project" : "",
    "--settings",
    settingsPath,
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-chrome",
    ...(session ? [session.option, session.id] : []),
    ...pluginDirs.flatMap((path) => ["--plugin-dir", path]),
  ];
}

function claudeObservationRoot(
  stateRoot: string,
  credential: string,
  request: Request,
): string {
  return request.runtimePolicy?.nativeTranscripts === true
    ? join(stateRoot, "native-home")
    : dirname(credential);
}

async function repositoryObservation(
  execution: Execution,
  configRoot: string,
  request: Request,
  invocation: RepositoryInvocation | null,
  tools: ReturnType<typeof claudeToolCallsObservation>,
) {
  if (!invocation) return null;
  return claudeRepositoryInvocationObservation({
    invocation,
    stream: execution.initialOut ?? execution.out,
    configRoot: configRoot,
    workspace: request.workspace,
    tools: execution.initialOut
      ? claudeToolCallsObservation(execution.initialOut, 0)
      : tools,
  });
}

async function claudeObservations(
  execution: Execution,
  configRoot: string,
  request: Request,
  invocation: RepositoryInvocation | null,
) {
  const nested = await claudeNestedSkillsObservation(
    execution.out,
    configRoot,
    request.workspace,
  );
  const tools = claudeToolCallsObservation(execution.out, execution.code);
  const repository = await repositoryObservation(
    execution,
    configRoot,
    request,
    invocation,
    tools,
  );
  return [
    tools,
    ...runtimeObservations(request.runtimePolicy, request.runtimeRole),
    await observeClaudeNativeGoal(
      configRoot,
      execution.followUpOut ?? execution.out,
    ),
    nested,
    claudeNativeControls(execution.out, execution.code),
    ...(repository ? [repository] : []),
    ...(execution.continuation ? [execution.continuation] : []),
  ];
}

function claudeArtifacts(execution: Execution) {
  return [
    { id: "sevro.claude.events", bytes: Buffer.from(execution.out, "utf8") },
    ...(execution.initialOut !== undefined
      ? [
          {
            id: "sevro.claude.initial-events",
            bytes: Buffer.from(execution.initialOut, "utf8"),
          },
        ]
      : []),
    ...(execution.followUpOut !== undefined
      ? [
          {
            id: "sevro.claude.follow-up-events",
            bytes: Buffer.from(execution.followUpOut, "utf8"),
          },
        ]
      : []),
    ...(execution.err
      ? [
          {
            id: "sevro.claude.stderr",
            bytes: Buffer.from(execution.err, "utf8"),
          },
        ]
      : []),
  ];
}

function measuredClaudeUsage(
  summary: ReturnType<typeof summarizeClaudeEvents>,
  execution: Execution,
) {
  return {
    inputTokens:
      execution.sessionResultsBound === false ? null : summary.inputTokens,
    outputTokens:
      execution.sessionResultsBound === false ? null : summary.outputTokens,
    costUsd: execution.sessionResultsBound === false ? null : summary.costUsd,
    usageComplete:
      execution.sessionResultsBound !== false && summary.usageComplete,
  };
}

async function claudeResult(
  execution: Execution,
  configRoot: string,
  request: Request,
  invocation: RepositoryInvocation | null,
): Promise<HostResult> {
  const summary = summarizeClaudeEvents(execution.out, execution.code);
  const observations = await claudeObservations(
    execution,
    configRoot,
    request,
    invocation,
  );
  return {
    finalMessage: summary.finalMessage,
    complete: summary.complete,
    executionFailed: !summary.complete,
    observations,
    artifacts: claudeArtifacts(execution),
    actualCondition: "passive",
    ...measuredClaudeUsage(summary, execution),
  };
}
