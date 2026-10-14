/** Shared structures; public schemas and runtime guards still validate external data. */
export type ExecutionStatus = "completed" | "failed" | "cancelled" | "not_run";
export type GradingStatus =
  "completed" | "error" | "unavailable" | "not_requested";
export type TaskVerdict = "passed" | "failed" | "not_assessed";
export type OutcomeStatus = "passed" | "failed" | "unavailable";
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 64 | 70 | 130 | 143;

export interface Assessment {
  execution: { status: ExecutionStatus };
  grading: { status: GradingStatus };
  task: { verdict: TaskVerdict };
}

export type CheckDeclaration = {
  id: string;
  grader: string;
  configuration: Record<string, unknown>;
};

/** Runner check outcomes include their grader and may lack evidence references. */
export interface CheckOutcome {
  id: string;
  grader: string;
  status: OutcomeStatus;
  detail?: string;
  evidenceRefs?: string[];
}

/** Extension checks require references; their grader comes from the declaration. */
export type ExtensionCheckOutcome = {
  id: string;
  status: OutcomeStatus;
  detail?: string;
  evidenceRefs: string[];
};

/** Domain outcomes are retained independently of task checks and verdicts. */
export type DomainOutcome = {
  id: string;
  status: OutcomeStatus;
  detail?: string;
  evidenceRefs: string[];
  data?: Record<string, unknown>;
};

export type ObservationCompleteness = "complete" | "partial" | "unavailable";

export type ObservationEvidence = {
  id: string;
  source: string;
  completeness: ObservationCompleteness;
  data: Record<string, unknown>;
};

export type MetricEvidence = {
  id: string;
  value: number | null;
  unit: string;
};

/** Retained measurements keep unknown values and completeness separate. */
export type UsageEvidence = {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  complete: boolean;
};

export type RawResultReference = {
  source: string;
  path: string | null;
  sha256: string | null;
};

export type ArtifactReference = {
  id: string;
  path: string;
  sha256: string;
  gitExclude?: boolean;
  executable?: boolean;
};

export type EvidenceRoute = {
  role: "candidate" | "semantic" | "advisory";
  host: string;
  model: string;
  effort: string;
};

export type Diagnostic = {
  code: string;
  message: string;
};
