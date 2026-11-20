/**
 * One judge request: a semantic check group or an advisory review sent to a
 * judge host in its own auxiliary workspace. It owns the host request, the
 * failure policy, role-scoped evidence and the workspace rule; callers supply
 * the prompt and the parser for the judge's answer.
 */
import { hostArtifacts, TrialPersistenceError } from "../evidence/index";
import type { TrialEvidenceWriter } from "../evidence/index";
import {
  HostExecutionFailure,
  type HostAdapter,
  type HostResult,
} from "../host-contract/index";
import { HostDiagnosticPersistenceError } from "../diagnostics/index";
import type { CandidateArtifactRoots, RuntimePolicy } from "../runtime/index";
import { gradingRuntimePolicy } from "./grading-host";

export interface JudgeRequest<T> {
  readonly host: HostAdapter;
  readonly role: "semantic" | "advisory";
  /** Prefix for the judge's host artifacts, such as `sevro.advisory.`. */
  readonly artifactPrefix: string;
  /** The evidence id the caller retains the raw response under. */
  readonly responseId: string;
  readonly declaredChecks: readonly { id: string }[];
  readonly runtimePolicy?: RuntimePolicy;
  /** Only semantic-role seeds reach a judge reading the candidate's response. */
  readonly responseOnly?: boolean;
  readonly candidateTranscriptRoot?: string;
  readonly candidateArtifactRoots?: CandidateArtifactRoots;
  readonly signal?: AbortSignal;
  createWorkspace(): Promise<string>;
  /** Called only after a parsed answer; failed requests retain the workspace. */
  disposeWorkspace(workspace: string): Promise<void>;
  /** Built after the workspace exists; failures count as a failed request. */
  prompt(): Promise<string>;
  parse(message: string): T;
}

export interface JudgeEffects {
  readonly evidence: Pick<
    TrialEvidenceWriter,
    "artifactRefs" | "retainArtifacts"
  >;
  /** Retain the judge's raw final message, complete or not. */
  retainResponse(hostId: string, message: string | null): Promise<void>;
  retainWorkspace(workspace: string): Promise<void>;
}

/** A failed request carries the judge's result whenever the host produced one. */
export type JudgeOutcome<T> =
  | { status: "answered"; answer: T; response: HostResult }
  | { status: "failed"; response: HostResult | null };

/** Run one judge request; only evidence persistence failures propagate. */
export async function runJudgeRequest<T>(
  request: JudgeRequest<T>,
  effects: JudgeEffects,
): Promise<JudgeOutcome<T>> {
  let workspace: string | null = null;
  let outcome: JudgeOutcome<T> = { status: "failed", response: null };
  try {
    workspace = await request.createWorkspace();
    const response = await askJudge(request, effects, workspace);
    outcome = { status: "failed", response };
    await retainJudgeEvidence(request, effects, response);
    outcome = {
      status: "answered",
      answer: request.parse(completeMessage(response)),
      response,
    };
  } catch (error) {
    if (persistenceError(error)) throw error;
  } finally {
    await finishWorkspace(request, effects, workspace, outcome);
  }
  return outcome;
}

async function askJudge<T>(
  request: JudgeRequest<T>,
  effects: JudgeEffects,
  workspace: string,
): Promise<HostResult> {
  const hostRequest = {
    retainHostDiagnostics: (bytes: Uint8Array) =>
      effects.evidence.retainArtifacts([
        {
          id: `${request.artifactPrefix}sevro.host.diagnostics`,
          bytes: Buffer.from(bytes),
        },
      ]),
    candidateTranscriptRoot: request.candidateTranscriptRoot,
    candidateArtifactRoots: request.candidateArtifactRoots,
    prompt: await request.prompt(),
    runtimePolicy: gradingRuntimePolicy(
      request.runtimePolicy,
      request.responseOnly,
    ),
    runtimeRole: request.role,
    workspace,
    condition: "passive" as const,
    signal: request.signal,
  };
  try {
    return await request.host.run(hostRequest);
  } catch (cause) {
    // A failed judge's own result is still evidence, however the host threw.
    if (cause instanceof HostExecutionFailure) return cause.result;
    throw cause;
  }
}

async function retainJudgeEvidence<T>(
  request: JudgeRequest<T>,
  effects: JudgeEffects,
  response: HostResult,
): Promise<void> {
  await effects.evidence.retainArtifacts(
    hostArtifacts(
      {
        ...response,
        artifacts: response.artifacts?.map((item) => ({
          ...item,
          id: `${request.artifactPrefix}${item.id}`,
        })),
      },
      new Set([
        ...effects.evidence.artifactRefs.map((item) => item.id),
        ...request.declaredChecks.map((item) => item.id),
        request.responseId,
      ]),
    ),
  );
  await effects.retainResponse(request.host.id, response.finalMessage);
}

function completeMessage(response: HostResult): string {
  if (response.executionFailed || !response.complete || !response.finalMessage)
    throw new Error("judge response is incomplete");
  return response.finalMessage;
}

function persistenceError(error: unknown): boolean {
  return (
    error instanceof HostDiagnosticPersistenceError ||
    error instanceof TrialPersistenceError
  );
}

async function finishWorkspace<T>(
  request: JudgeRequest<T>,
  effects: JudgeEffects,
  workspace: string | null,
  outcome: JudgeOutcome<T>,
): Promise<void> {
  if (workspace === null) return;
  if (outcome.status === "answered") await request.disposeWorkspace(workspace);
  else await effects.retainWorkspace(workspace);
}
