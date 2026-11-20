import {
  verifyClaudeRepositoryMount,
  verifyClaudePluginInvocation,
  type ClaudeRepositoryInvocation,
} from "./claude-invocation";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { HostAdapter } from "../host-contract/index";
import { runtimeHooksEnabled } from "../hooks/index";
import {
  runClaudeNativeSession,
  type ClaudeNativeSession,
  type ClaudeSessionOption,
} from "./claude-native-session";
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
      const session = await runClaudeNativeSession({
        prompt: request.prompt,
        followUpPrompt: request.followUpPrompt,
        workspace: request.workspace,
        configRoot: claudeConfigRoot(stateRoot, state.credential, request),
        run,
      });
      return claudeResult(session, state.repositoryInvocation);
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
  return (prompt: string, session: ClaudeSessionOption) => {
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
  session: ClaudeSessionOption,
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
    session.option,
    session.id,
    ...pluginDirs.flatMap((path) => ["--plugin-dir", path]),
  ];
}

/** Where this request's Claude configuration, and so its native transcripts, live. */
function claudeConfigRoot(
  stateRoot: string,
  credential: string,
  request: Request,
): string {
  return request.runtimePolicy?.nativeTranscripts === true
    ? join(stateRoot, "native-home")
    : dirname(credential);
}

async function repositoryObservation(
  session: ClaudeNativeSession,
  invocation: ClaudeRepositoryInvocation | null,
  tools: ReturnType<typeof claudeToolCallsObservation>,
) {
  if (!invocation) return null;
  return claudeRepositoryInvocationObservation({
    invocation,
    session,
    // Repository invocation is initial-turn evidence.
    tools: session.followUp
      ? claudeToolCallsObservation(session.initial.events, 0)
      : tools,
  });
}

async function claudeObservations(
  session: ClaudeNativeSession,
  invocation: ClaudeRepositoryInvocation | null,
) {
  const { events, code } = session.combined;
  const tools = claudeToolCallsObservation(events, code);
  const repository = await repositoryObservation(session, invocation, tools);
  return {
    beforeRuntime: [tools],
    observations: [
      await observeClaudeNativeGoal(session),
      claudeNativeControls(events, code),
      ...(repository ? [repository] : []),
      ...(session.continuation ? [session.continuation] : []),
      claudeSkillActivationsObservation(events, code),
    ],
  };
}

function eventArtifact(id: string, text: string) {
  return { id, bytes: Buffer.from(text, "utf8") };
}

function claudeArtifacts(session: ClaudeNativeSession) {
  const { out, err } = session.combined;
  return [
    eventArtifact("sevro.claude.events", out),
    ...(session.followUp
      ? [
          eventArtifact("sevro.claude.initial-events", session.initial.out),
          eventArtifact("sevro.claude.follow-up-events", session.followUp.out),
        ]
      : []),
    ...(err ? [eventArtifact("sevro.claude.stderr", err)] : []),
  ];
}

/** Results not bound to the named session are not measured. */
function measuredClaudeUsage(
  summary: ReturnType<typeof summarizeClaudeEvents>,
  session: ClaudeNativeSession,
) {
  if (!session.bound)
    return {
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      usageComplete: false,
    };
  return {
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    costUsd: summary.costUsd,
    usageComplete: summary.usageComplete,
  };
}

async function claudeResult(
  session: ClaudeNativeSession,
  invocation: ClaudeRepositoryInvocation | null,
): Promise<NativeHostRequestOutcome> {
  const summary = summarizeClaudeEvents(
    session.combined.events,
    session.combined.code,
  );
  const observations = await claudeObservations(session, invocation);
  return {
    result: {
      finalMessage: summary.finalMessage,
      complete: summary.complete,
      executionFailed: !summary.complete,
      artifacts: claudeArtifacts(session),
      ...measuredClaudeUsage(summary, session),
    },
    ...(session.bound ? { rootSessionId: session.id } : {}),
    ...observations,
  };
}
