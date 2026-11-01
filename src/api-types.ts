import type {
  CliResultData,
  CliResultDataCase,
  CliResultDataTrial,
} from "./schema-types";

/** An evaluation always has allocated run and evidence paths. */
export interface EvaluationResult extends Omit<
  CliResultData,
  "runId" | "evidencePath" | "exitCode" | "cases"
> {
  runId: string;
  evidencePath: string;
  exitCode: number;
  cases: EvaluationCaseResult[];
}

export interface EvaluationCaseResult extends Omit<
  CliResultDataCase,
  "trials"
> {
  trials: EvaluationTrialResult[];
}

export interface EvaluationTrialResult extends Omit<
  CliResultDataTrial,
  "artifactPath" | "domainOutcomes"
> {
  artifactPath: string;
  domainOutcomes: NonNullable<CliResultDataTrial["domainOutcomes"]>;
}

export interface EvaluationProgress {
  stage: "preparation" | "candidate" | "grading" | "evidence";
  status: "started" | "completed" | "skipped";
  trial?: number;
}

export interface EvaluateOptions {
  /** CLI-equivalent arguments, including the initial "run" command. */
  argv: readonly string[];
  /** Caller-owned cancellation; the API installs no process signal handlers. */
  signal?: AbortSignal;
  /** Best-effort observation; callback exceptions do not affect evaluation. */
  onProgress?: (event: EvaluationProgress) => void;
  /** Deprecation and cleanup diagnostics; omitted callbacks leave the API silent. */
  onWarning?: (message: string) => void;
}
