import {
  verifyClaudeRepositoryMount,
  verifyClaudePluginInvocation,
  type ClaudeRepositoryInvocation,
} from "./claude-invocation";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { HostAdapter } from "../host-contract/index";
import { runtimeHooksEnabled } from "../hooks/index";
import { runClaudeTurns, type ClaudeSession } from "./claude-continuation";
import {
  runNativeHostRequest,
  type NativeHost,
  type NativeHostRequestOutcome,
} from "./native-host-request";
import {
  claudeSkillActivationsObservation,
  claudeToolCallsObservation,
  summarizeClaudeEvents,
} from "../host-events/index";
import { observeClaudeNativeGoal } from "./claude-native-goal";
import { runClaudeProcess, validHostTimeout } from "../native-process/index";
import { claudeRepositoryInvocationObservation } from "./claude-repository-invocation";
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
type Execution = Awaited<ReturnType<typeof runClaudeTurns>>;

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
      return runNativeHostRequest(
        claudeNativeHost(options, timeoutMs),
        request,
      );
    },
  };
}

/** Every turn shares one access token, so it must outlive all of them. */
function claudeLoginLifetime(timeoutMs: number, request: Request): number {
  const turns = request.followUpPrompt === undefined ? 1 : 2;
  return timeoutMs * turns + CLAUDE_LOGIN_MARGIN_MS;
}

function claudeNativeHost(
  options: ClaudeHostOptions,
  timeoutMs: number,
): NativeHost<
  Awaited<ReturnType<typeof validateClaudeRequest>>,
  Awaited<ReturnType<typeof prepareClaudeState>> & {
    repositoryInvocation: ClaudeRepositoryInvocation | null;
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
  const pluginDirs = await verifyClaudePluginInvocation(request);
  requireIsolatedHookSources(request, options);
  const repositoryInvocation = await verifyClaudeRepositoryMount(
    request,
    options.projectSettings,
  );
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
  invocation: ClaudeRepositoryInvocation | null,
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
  invocation: ClaudeRepositoryInvocation | null,
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
  invocation: ClaudeRepositoryInvocation | null,
): Promise<NativeHostRequestOutcome> {
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
