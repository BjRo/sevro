import { existsSync } from "node:fs";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { HostAdapter, HostResult } from "../engine";
import {
  allocateNativeState,
  requireNativeTranscriptView,
} from "../native-transcript-state";
import {
  failedNativeTranscripts,
  retainEnabledNativeTranscripts,
} from "../native-transcripts";
import { fixtureParts } from "../preparation";
import {
  prepareHookMounts,
  releaseRuntimeHooks,
  runtimeHookObservation,
  runtimeHooksEnabled,
  type HookMounts,
} from "../runtime-hooks";
import { insideRuntimeRoot as inside } from "../runtime-paths";
import { runtimeObservations } from "../runtime-state";
import { isOptionalNonblankString, isRecord } from "../value-guards";
import { runClaudeTurns, type ClaudeSession } from "./claude-continuation";
import { summarizeClaudeEvents } from "./claude-events";
import { observeClaudeNativeGoal } from "./claude-native-goal";
import { claudeNestedSkillsObservation } from "./claude-nested-skills";
import { runClaudeProcess } from "./claude-process";
import {
  claudeRepositoryInvocationObservation,
  verifyClaudeRepositoryInvocation,
} from "./claude-repository-invocation";
import { prepareClaudeState, type ClaudeHostOptions } from "./claude-state";
import { claudeToolCallsObservation } from "./claude-tool-calls";
import { claudeNativeControls } from "./native-controls";
export type { ClaudeHostOptions } from "./claude-state";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

type Request = Parameters<HostAdapter["run"]>[0];
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
  if (!isOptionalNonblankString(request.followUpPrompt))
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
  const stateRoot = await allocateNativeState(
    "claude-",
    request.runtimePolicy ? request.workspace : undefined,
  );
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
