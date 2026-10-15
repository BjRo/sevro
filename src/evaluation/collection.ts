import { checkpointRunOwner, type RunOwner } from "../run-owner";
import { summarizeAssessments, type Assessment } from "../results";
import type { Diagnostic } from "../contract-types";
import type { RunEvidenceDataTrialEvidence } from "../schema-types";
import type { CaseSummary, TrialSummary } from "./types";

type TrialEvidence = RunEvidenceDataTrialEvidence;

export interface CompletedTrial {
  readonly summary: TrialSummary;
  readonly evidence: TrialEvidence;
  readonly diagnostic?: Diagnostic;
}

export interface CollectedResults {
  readonly caseSummary: CaseSummary;
  readonly trials: readonly TrialEvidence[];
  readonly diagnostic: Diagnostic | undefined;
}

/** Registers retained trials before checkpointing; owns their final ordering. */
export class ResultCollector {
  private readonly summaries: TrialSummary[] = [];
  private readonly evidence: TrialEvidence[] = [];
  private readonly diagnostics: { trial: number; diagnostic: Diagnostic }[] =
    [];

  constructor(private readonly owner: RunOwner) {}

  complete(record: CompletedTrial): void {
    this.summaries.push(record.summary);
    this.summaries.sort((left, right) => left.trial - right.trial);
    this.evidence.push(record.evidence);
    this.evidence.sort((left, right) => left.trial - right.trial);
    if (record.diagnostic)
      this.diagnostics.push({
        trial: record.summary.trial,
        diagnostic: record.diagnostic,
      });
    this.checkpoint("active");
  }

  snapshot(input: {
    caseId: string;
    passThreshold: number;
    cancelled: boolean;
  }): CollectedResults {
    const assessment: Assessment =
      !this.summaries.length && input.cancelled
        ? {
            execution: { status: "cancelled" },
            grading: { status: "not_requested" },
            task: { verdict: "not_assessed" },
          }
        : summarizeAssessments(this.summaries, input.passThreshold);
    const diagnostic = this.diagnostics.sort(
      (left, right) => left.trial - right.trial,
    )[0]?.diagnostic;
    return {
      caseSummary: {
        caseId: input.caseId,
        ...assessment,
        trials: this.summaries,
      },
      trials: this.evidence,
      diagnostic,
    };
  }

  checkpoint(status: "active" | "complete" | "interrupted"): void {
    checkpointRunOwner(this.owner, this.checkpointTrials(), status);
  }

  diagnoseFailure(): void {
    try {
      checkpointRunOwner(this.owner, this.checkpointTrials(), "diagnostic");
    } catch {
      /* Preserve the original failure and retained artifacts. */
    }
  }

  private checkpointTrials() {
    return this.summaries.map((trial) => ({
      trial: trial.trial,
      artifactPath: trial.artifactPath,
    }));
  }
}
