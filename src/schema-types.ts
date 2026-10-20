import type { AdvisoryAssessment } from "./advisory";
import type {
  ArtifactReference,
  Assessment,
  CheckOutcome,
  Diagnostic,
  DomainOutcome,
  EvidenceRoute,
  ExecutionStatus,
  ExitCode,
  GradingStatus,
  MetricEvidence,
  ObservationCompleteness,
  ObservationEvidence,
  OutcomeStatus,
  RawResultReference,
  TaskVerdict,
  UsageEvidence,
} from "./contract-types";
import type { IdentityDimensions } from "./identity";
import type { InstrumentationRequest } from "./instrumentation";

/** Wire assessments additionally allow optional serialized error codes. */
export type WireAssessment = {
  execution: Assessment["execution"] & { errorCode?: string };
  grading: Assessment["grading"] & { errorCode?: string };
  task: Assessment["task"];
};

/** Validated v1 wire data also represents failures before run allocation. */
export type CliResultData = WireAssessment & {
  format: "sevro.cli-result.v1";
  runId: string | null;
  exitCode: ExitCode;
  evidencePath: string | null;
  cases: Array<CliResultDataCase>;
  diagnostic?: Diagnostic;
};
export type CliResultDataTrial = WireAssessment & {
  trial: number;
  checks: Array<CheckOutcome>;
  domainOutcomes?: Array<DomainOutcome>;
  artifactPath: string | null;
};
export type CliResultDataCase = WireAssessment & {
  caseId: string;
  trials: Array<CliResultDataTrial>;
};

/** Structural contracts for data validated by the versioned JSON schemas. */
export type RunEvidenceData = {
  format: "sevro.run-evidence.v1";
  runId: string;
  evaluationIdentity: {
    algorithm: "sevro.identity.v1";
    digest: RunEvidenceDataDigest;
    dimensions: IdentityDimensions;
  };
  configuration: {
    digest: RunEvidenceDataDigest;
    redacted: Record<string, unknown>;
    resolved?: Record<string, unknown>;
  };
  runner: RunEvidenceDataRunner;
  project: {
    root: RunEvidenceDataFileUrl;
    revision: string | null;
    dirtyPatchDigest: RunEvidenceDataDigest | null;
  };
  extension: null | RunEvidenceDataExtension;
  condition: {
    requested: "passive" | "enforced";
    actual: "passive" | "enforced" | "unknown";
    requestedInstrumentation: InstrumentationRequest[];
    appliedInstrumentation: InstrumentationRequest[];
  };
  graders: {
    active: Array<RunEvidenceDataGrader>;
    replacedDefaults: Array<string>;
  };
  routes: Array<EvidenceRoute>;
  result: CliResultData;
  trials: Array<RunEvidenceDataTrialEvidence>;
  diagnostic?: Diagnostic;
};
type RunEvidenceDataDigest = string;
type RunEvidenceDataFileUrl = string;
type RunEvidenceDataRunner =
  | {
      source: "package";
      packageName: string;
      version: string;
      buildDigest: RunEvidenceDataDigest;
    }
  | {
      source: "checkout";
      root: RunEvidenceDataFileUrl;
      revision: string;
      dirtyPatchDigest: RunEvidenceDataDigest | null;
      buildDigest: RunEvidenceDataDigest;
    };
type RunEvidenceDataExtension = {
  id: string;
  version: string;
  sourceDigest: RunEvidenceDataDigest;
  configurationDigest: RunEvidenceDataDigest;
  protocol: "sevro.extension.v1";
  capabilities: Array<string>;
  replacements: { graders: Array<string>; taskVerdictPolicy: string | null };
};
type RunEvidenceDataGrader = {
  id: string;
  source: "builtin" | "extension";
  version: string;
};
export type AdvisoryReviewData = {
  status: "completed" | "failed" | "not_run";
  assessment: AdvisoryAssessment | null;
  usage: UsageEvidence;
  rawResult: RawResultReference;
};
export type RunEvidenceDataTrialEvidence = {
  caseId: string;
  trial: number;
  executionMode: "executed" | "dry" | "unknown";
  candidateDurationMs?: number | null;
  condition: {
    requested: "passive" | "enforced";
    actual: "passive" | "enforced" | "unknown";
    appliedInstrumentation: InstrumentationRequest[];
  };
  observationCompleteness: ObservationCompleteness;
  observations: Array<ObservationEvidence>;
  metrics: Array<MetricEvidence>;
  domainOutcomes?: Array<DomainOutcome>;
  taskVerdictPolicy: null | {
    id: string;
    recommendation: TaskVerdict | null;
  };
  advisoryReview?: AdvisoryReviewData | null;
  routes: Array<EvidenceRoute>;
  usage: UsageEvidence;
  rawResult: RawResultReference;
  artifactRefs: Array<ArtifactReference>;
};
export type ReportData = {
  format: "sevro.report.v1";
  inputs: Array<ReportDataInput>;
  rows: Array<ReportDataRow>;
  summary: {
    cases: number;
    passed: number;
    failed: number;
    notAssessed: number;
  };
};
type ReportDataPath = string;
type ReportDataDigest = string;
/** The report wire schema deliberately allows either state family in rows. */
type ReportDataState = ExecutionStatus | GradingStatus;
type ReportDataInput = {
  resultFile: ReportDataPath;
  execution: ExecutionStatus;
  grading: GradingStatus;
  task: TaskVerdict;
  exitCode: ExitCode;
  caseCount: number;
};
type ReportDataRoute = Omit<EvidenceRoute, "role">;
type ReportDataOutcome = {
  trial: number;
  id: string;
  status: OutcomeStatus;
};
type ReportDataRow = {
  nativeTranscripts?: { retained: number; pruned: number };
  resultFile: ReportDataPath;
  evidencePath: string | null;
  runId: string | null;
  caseId: string;
  execution: ReportDataState;
  grading: ReportDataState;
  task: TaskVerdict;
  exitCode: ExitCode;
  trialCount: number;
  taskPassRate: number | null;
  candidateDurationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  runnerBuildDigest: ReportDataDigest | null;
  evaluationDigest: ReportDataDigest | null;
  requestedCondition: "passive" | "enforced" | null;
  actualCondition: "passive" | "enforced" | "unknown" | null;
  candidateRoute: ReportDataRoute | null;
  routes: Array<EvidenceRoute>;
  domainOutcomes: Array<ReportDataOutcome>;
};
