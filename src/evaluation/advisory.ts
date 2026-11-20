import {
  advisoryPrompt,
  parseAdvisoryRecommendation,
  type AdvisoryRecommendation,
  type CheckOutcome,
} from "../kernel/index";
import type { CandidateArtifactRoots, RuntimePolicy } from "../runtime/index";
import {
  TrialPersistenceError,
  usage,
  type TrialEvidenceWriter,
} from "../evidence/index";
import { buildBlindAdvisoryWorkspace } from "../fixtures/index";
import { removeWorkspace } from "../workspace/index";
import { HostDiagnosticPersistenceError } from "../diagnostics/index";
import type { AdvisoryReviewData } from "../schema/index";
import { gradingRuntimePolicy, scopedHostArtifacts } from "./grading-host";
import { evaluationWarning } from "./progress";
import type { HostAdapter, HostResult } from "../host-contract/index";

export type AdvisoryReview = AdvisoryReviewData;

interface AdvisoryInput {
  readonly host: HostAdapter;
  readonly candidateCompleted: boolean;
  readonly candidateWorkspace: string;
  readonly candidateTranscriptRoot?: string;
  readonly candidateArtifactRoots?: CandidateArtifactRoots;
  readonly baseRevision: string | null;
  readonly excludedPaths?: string[];
  readonly task: string;
  readonly checks: readonly CheckOutcome[];
  readonly declaredChecks: { id: string }[];
  readonly runtimePolicy?: RuntimePolicy;
  readonly signal?: AbortSignal;
}

interface AdvisoryEffects {
  onWarning?: (message: string) => void;
  readonly evidence: Pick<
    TrialEvidenceWriter,
    "artifactRefs" | "retainArtifacts" | "retainAdvisoryResponse"
  >;
  retainWorkspace(workspace: string): Promise<void>;
}

function defaultAdvisoryReview(host: HostAdapter): AdvisoryReview {
  return {
    status: "not_run",
    assessment: null,
    usage: usage(null),
    rawResult: { source: host.id, path: null, sha256: null },
  };
}

function completeAdvisoryRecommendation(
  response: HostResult,
): AdvisoryRecommendation {
  if (
    response.executionFailed ||
    !response.complete ||
    response.finalMessage === null
  )
    throw new Error("advisory response is incomplete");
  return parseAdvisoryRecommendation(response.finalMessage);
}

async function cleanupAdvisoryWorkspace(
  workspace: string | null,
  successful: boolean,
  effects: AdvisoryEffects,
): Promise<void> {
  if (!workspace) return;
  if (!successful) return effects.retainWorkspace(workspace);
  try {
    await removeWorkspace(workspace);
  } catch {
    evaluationWarning(
      effects.onWarning,
      `advisory fixture cleanup failed; retained at ${workspace}`,
    );
  }
}

async function executeAdvisoryReview(
  input: AdvisoryInput,
  effects: AdvisoryEffects,
  review: AdvisoryReview,
): Promise<void> {
  let workspace: string | null = null;
  try {
    if (input.baseRevision === null)
      throw new Error("advisory base revision is unavailable");
    workspace = await buildBlindAdvisoryWorkspace(input.candidateWorkspace, {
      baseRevision: input.baseRevision,
      excludedPaths: input.excludedPaths,
    });
    const response = await input.host.run({
      retainHostDiagnostics: (bytes) =>
        effects.evidence.retainArtifacts([
          {
            id: "sevro.advisory.sevro.host.diagnostics",
            bytes: Buffer.from(bytes),
          },
        ]),
      candidateTranscriptRoot: input.candidateTranscriptRoot,
      candidateArtifactRoots: input.candidateArtifactRoots,
      prompt: advisoryPrompt(input.task, [...input.checks]),
      runtimePolicy: gradingRuntimePolicy(input.runtimePolicy),
      runtimeRole: "advisory",
      workspace,
      condition: "passive",
      signal: input.signal,
    });
    review.usage = usage(response);
    const artifacts = scopedHostArtifacts(
      response,
      "sevro.advisory.",
      effects.evidence.artifactRefs,
      input.declaredChecks,
      "sevro.advisory.response",
    );
    await effects.evidence.retainArtifacts(artifacts);
    review.rawResult = await effects.evidence.retainAdvisoryResponse(
      input.host.id,
      response.finalMessage,
    );
    review.assessment = completeAdvisoryRecommendation(response);
    review.status = "completed";
  } catch (error) {
    if (
      error instanceof HostDiagnosticPersistenceError ||
      error instanceof TrialPersistenceError
    )
      throw error;
    review.status = "failed";
  } finally {
    await cleanupAdvisoryWorkspace(
      workspace,
      review.status === "completed",
      effects,
    );
  }
}

/** Advisory execution depends on candidate completion, independently of task grading. */
export async function runAdvisoryReview(
  input: AdvisoryInput,
  effects: AdvisoryEffects,
): Promise<AdvisoryReview> {
  const review = defaultAdvisoryReview(input.host);
  if (!input.candidateCompleted || input.signal?.aborted) return review;
  await executeAdvisoryReview(input, effects, review);
  return review;
}
