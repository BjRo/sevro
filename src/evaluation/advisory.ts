import {
  advisoryPrompt,
  parseAdvisoryRecommendation,
  type CheckOutcome,
} from "../kernel/index";
import type { CandidateArtifactRoots, RuntimePolicy } from "../runtime/index";
import { usage, type TrialEvidenceWriter } from "../evidence/index";
import { buildBlindAdvisoryWorkspace } from "../fixtures/index";
import { removeWorkspace } from "../workspace/index";
import type { AdvisoryReviewData } from "../schema/index";
import { runJudgeRequest } from "./judge-request";
import { evaluationWarning } from "./progress";
import type { HostAdapter } from "../host-contract/index";

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

async function removeAdvisoryWorkspace(
  workspace: string,
  effects: AdvisoryEffects,
): Promise<void> {
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
  const outcome = await runJudgeRequest(
    {
      host: input.host,
      role: "advisory",
      artifactPrefix: "sevro.advisory.",
      responseId: "sevro.advisory.response",
      declaredChecks: input.declaredChecks,
      runtimePolicy: input.runtimePolicy,
      candidateTranscriptRoot: input.candidateTranscriptRoot,
      candidateArtifactRoots: input.candidateArtifactRoots,
      signal: input.signal,
      createWorkspace() {
        const baseRevision = input.baseRevision;
        if (baseRevision === null)
          throw new Error("advisory base revision is unavailable");
        return buildBlindAdvisoryWorkspace(input.candidateWorkspace, {
          baseRevision,
          excludedPaths: input.excludedPaths,
        });
      },
      disposeWorkspace: (workspace) =>
        removeAdvisoryWorkspace(workspace, effects),
      prompt: () =>
        Promise.resolve(advisoryPrompt(input.task, [...input.checks])),
      parse: parseAdvisoryRecommendation,
    },
    {
      evidence: effects.evidence,
      async retainResponse(hostId, message) {
        review.rawResult = await effects.evidence.retainAdvisoryResponse(
          hostId,
          message,
        );
      },
      retainWorkspace: (workspace) => effects.retainWorkspace(workspace),
    },
  );
  if (outcome.response) review.usage = usage(outcome.response);
  if (outcome.status === "answered") {
    review.assessment = outcome.answer;
    review.status = "completed";
  } else review.status = "failed";
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
