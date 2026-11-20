import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { HostAdapter } from "../host-contract/index";
import { insideRuntimeRoot as inside } from "../runtime/index";
import { fixtureParts } from "../fixtures/index";
import { runtimeHooksEnabled } from "../hooks/index";
import { isRecord } from "../kernel/index";
import { runClaudeTurns, type ClaudeSession } from "./claude-continuation";
import {
  runNativeRun,
  type NativeRunAdapter,
  type NativeRunOutcome,
} from "./native-run";
import {
  claudeSkillActivationsObservation,
  claudeToolCallsObservation,
  summarizeClaudeEvents,
} from "../host-events/index";
import { observeClaudeNativeGoal } from "./claude-native-goal";
import { runClaudeProcess, validHostTimeout } from "../native-process/index";
import {
  claudeRepositoryInvocationObservation,
  verifyClaudeRepositoryInvocation,
} from "./claude-repository-invocation";
import { prepareClaudeState, type ClaudeHostOptions } from "./claude-state";
import {
  diagnosticConfiguration,
  type HostDiagnostics,
} from "../diagnostics/index";
import {
  CLAUDE_AUTH_VARIABLES,
  CLAUDE_LOGIN_MARGIN_MS,
} from "../claude-login/index";
import { claudeNativeControls } from "../native-controls/index";
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
  return !!effort && validHostTimeout(timeoutMs);
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
    ...(options.retainHostDiagnostics
      ? {
          configuration: diagnosticConfiguration(options.retainHostDiagnostics),
        }
      : {}),
    hostCapabilities: [
      "sevro.host.native-goal",
      "sevro.host.runtime",
      "sevro.host.native-transcripts",
      "sevro.host.hooks",
      "sevro.host.skill-activations",
      "sevro.claude.plugin-dirs",
      "sevro.claude.explicit-invocation",
      ...(options.projectSettings
        ? ["sevro.claude.repository-invocation"]
        : []),
      "sevro.claude.tool-calls",
      "sevro.host.native-controls",
      "sevro.host.continuation",
      "sevro.claude.continuation",
    ],
    run(request) {
      return runNativeRun(claudeRunAdapter(options, timeoutMs), request);
    },
  };
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

/** Every turn shares one access token, so it must outlive all of them. */
function claudeLoginLifetime(timeoutMs: number, request: Request): number {
  const turns = request.followUpPrompt === undefined ? 1 : 2;
  return timeoutMs * turns + CLAUDE_LOGIN_MARGIN_MS;
}

function claudeRunAdapter(
  options: ClaudeHostOptions,
  timeoutMs: number,
): NativeRunAdapter<
  Awaited<ReturnType<typeof validateClaudeRequest>>,
  Awaited<ReturnType<typeof prepareClaudeState>> & {
    repositoryInvocation: RepositoryInvocation | null;
  }
> {
  return {
    host: "claude",
    credentialFile: options.credentialFile,
    retainHostDiagnostics: options.retainHostDiagnostics,
    transcriptDirectory: "native-home/projects",
    hookPosition: "last",
    validate: (request) => validateClaudeRequest(options, request),
    async prepare(context, admission) {
      const state = await prepareClaudeState(
        context.stateRoot,
        options,
        context.request,
        admission.pluginDirs,
        claudeLoginLifetime(timeoutMs, context.request),
      );
      context.diagnostics.registerCredentials(state.env, CLAUDE_AUTH_VARIABLES);
      context.hooks = state.hooks;
      return { ...state, repositoryInvocation: admission.repositoryInvocation };
    },
    async execute(context, state) {
      const { request, diagnostics, stateRoot } = context;
      const run = claudeProcessRunner(
        options,
        timeoutMs,
        request,
        state,
        diagnostics,
      );
      const execution = await runClaudeTurns({
        prompt: request.prompt,
        followUpPrompt: request.followUpPrompt,
        workspace: request.workspace,
        run,
      });
      return claudeResult(
        execution,
        claudeObservationRoot(stateRoot, state.credential, request),
        request,
        state.repositoryInvocation,
      );
    },
  };
}

function claudeProcessRunner(
  options: ClaudeHostOptions,
  timeoutMs: number,
  request: Request,
  state: Awaited<ReturnType<typeof prepareClaudeState>>,
  diagnostics: HostDiagnostics,
) {
  return (prompt: string, session?: ClaudeSession) => {
    diagnostics.stage = "claude-execution";
    return runClaudeProcess({
      diagnostics,
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
  };
}

async function validateClaudeRequest(
  options: ClaudeHostOptions,
  request: Request,
) {
  const pluginDirs = request.claudePluginDirs
    ? await pluginDirectories(request.workspace, request.claudePluginDirs)
    : [];
  await verifyInvocation(request, pluginDirs);
  requireIsolatedHookSources(request, options);
  const repositoryInvocation = await repositoryMount(request, options);
  return { pluginDirs, repositoryInvocation };
}

function requireIsolatedHookSources(
  request: Request,
  options: ClaudeHostOptions,
): void {
  if (runtimeHooksEnabled(request.runtimePolicy) && options.projectSettings)
    throw new Error("native goals require isolated hook sources");
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
    "Bash,Read,Edit,Skill,Agent,SendMessage",
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
    stream: execution.initialEvents ?? execution.events,
    configRoot: configRoot,
    workspace: request.workspace,
    tools: execution.initialEvents
      ? claudeToolCallsObservation(execution.initialEvents, 0)
      : tools,
  });
}

async function claudeObservations(
  execution: Execution,
  configRoot: string,
  request: Request,
  invocation: RepositoryInvocation | null,
) {
  const tools = claudeToolCallsObservation(execution.events, execution.code);
  const repository = await repositoryObservation(
    execution,
    configRoot,
    request,
    invocation,
    tools,
  );
  return {
    beforeRuntime: [tools],
    observations: [
      await observeClaudeNativeGoal(
        configRoot,
        execution.followUpEvents ?? execution.events,
      ),
      claudeNativeControls(execution.events, execution.code),
      ...(repository ? [repository] : []),
      ...(execution.continuation ? [execution.continuation] : []),
      claudeSkillActivationsObservation(execution.events, execution.code),
    ],
  };
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
): Promise<NativeRunOutcome> {
  const summary = summarizeClaudeEvents(execution.events, execution.code);
  const observations = await claudeObservations(
    execution,
    configRoot,
    request,
    invocation,
  );
  return {
    result: {
      finalMessage: summary.finalMessage,
      complete: summary.complete,
      executionFailed: !summary.complete,
      artifacts: claudeArtifacts(execution),
      ...measuredClaudeUsage(summary, execution),
    },
    ...observations,
  };
}
