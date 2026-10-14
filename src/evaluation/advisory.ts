import {
  advisoryPrompt,
  parseAdvisoryAssessment,
  type AdvisoryAssessment,
} from "../advisory";
import type { CandidateArtifactRoots } from "../candidate-artifacts";
import type { TrialEvidenceWriter } from "../evidence/trial-writer";
import { usage } from "../evidence/usage";
import { buildBlindAdvisoryFixture } from "../fixtures/advisory";
import { removeWorkspace } from "../fixtures/workspace-state";
import { HostDiagnosticPersistenceError } from "../host-diagnostics";
import type { CheckOutcome } from "../results";
import type { AdvisoryReviewData } from "../schema-types";
import type { RuntimePolicy } from "../runtime/config";
import { gradingRuntimePolicy, scopedHostArtifacts } from "./grading-host";
import {
  TrialPersistenceError,
  type HostAdapter,
  type HostResult,
} from "./types";

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

function completeAdvisoryAssessment(response: HostResult): AdvisoryAssessment {
  if (
    response.executionFailed ||
    !response.complete ||
    response.finalMessage === null
  )
    throw new Error("advisory response is incomplete");
  return parseAdvisoryAssessment(response.finalMessage);
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
    console.warn(`advisory fixture cleanup failed; retained at ${workspace}`);
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
    workspace = await buildBlindAdvisoryFixture(input.candidateWorkspace, {
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
    review.assessment = completeAdvisoryAssessment(response);
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
