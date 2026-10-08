/** Structural contracts for data validated by the versioned JSON schemas. */
export type CliResultData = {
  format: "sevro.cli-result.v1";
  runId: string | null;
  execution: CliResultDataExecution;
  grading: CliResultDataGrading;
  task: CliResultDataTask;
  exitCode: 0 | 1 | 2 | 3 | 4 | 64 | 70 | 130 | 143;
  evidencePath: string | null;
  cases: Array<CliResultDataCase>;
  diagnostic?: CliResultDataDiagnostic;
};
type CliResultDataExecution = {
  status: "completed" | "failed" | "cancelled" | "not_run";
  errorCode?: string;
};
type CliResultDataGrading = {
  status: "completed" | "error" | "unavailable" | "not_requested";
  errorCode?: string;
};
type CliResultDataTask = { verdict: "passed" | "failed" | "not_assessed" };
type CliResultDataCheck = {
  id: string;
  grader: string;
  status: "passed" | "failed" | "unavailable";
  detail?: string;
  evidenceRefs?: Array<string>;
};
type CliResultDataDomainOutcome = {
  id: string;
  status: "passed" | "failed" | "unavailable";
  detail?: string;
  evidenceRefs: Array<string>;
  data?: Record<string, unknown>;
};
type CliResultDataTrial = {
  trial: number;
  execution: CliResultDataExecution;
  grading: CliResultDataGrading;
  task: CliResultDataTask;
  checks: Array<CliResultDataCheck>;
  domainOutcomes?: Array<CliResultDataDomainOutcome>;
  artifactPath: string | null;
};
type CliResultDataCase = {
  caseId: string;
  execution: CliResultDataExecution;
  grading: CliResultDataGrading;
  task: CliResultDataTask;
  trials: Array<CliResultDataTrial>;
};
type CliResultDataDiagnostic = { code: string; message: string };
export type RunEvidenceData = {
  format: "sevro.run-evidence.v1";
  runId: string;
  evaluationIdentity: {
    algorithm: "sevro.identity.v1";
    digest: RunEvidenceDataDigest;
    dimensions: {
      runnerBuildDigest: RunEvidenceDataDigest;
      projectDigest: RunEvidenceDataDigest;
      configurationDigest: RunEvidenceDataDigest;
      extensionDigest: RunEvidenceDataDigest | null;
      extensionProtocol: "sevro.extension.v1" | null;
      caseDigest: RunEvidenceDataDigest;
      fixtureDigest: RunEvidenceDataDigest;
      checksDigest: RunEvidenceDataDigest;
      requiredEvidenceDigest: RunEvidenceDataDigest;
      evaluatorDigest: RunEvidenceDataDigest;
      graderDigest: RunEvidenceDataDigest;
      instrumentationDigest: RunEvidenceDataDigest;
      routeDigest: RunEvidenceDataDigest;
      condition: "passive" | "enforced";
      trialCount: number;
      passThreshold: number;
    };
  };
  configuration: {
    digest: RunEvidenceDataDigest;
    redacted: Record<string, unknown>;
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
    requestedInstrumentation: RunEvidenceDataInstrumentationList;
    appliedInstrumentation: RunEvidenceDataInstrumentationList;
  };
  graders: {
    active: Array<RunEvidenceDataGrader>;
    replacedDefaults: Array<string>;
  };
  routes: Array<RunEvidenceDataRoute>;
  result: CliResultData;
  trials: Array<RunEvidenceDataTrialEvidence>;
  diagnostic?: RunEvidenceDataDiagnostic;
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
type RunEvidenceDataInstrumentationList = Array<{
  id: string;
  configuration: Record<string, unknown>;
}>;
type RunEvidenceDataGrader = {
  id: string;
  source: "builtin" | "extension";
  version: string;
};
type RunEvidenceDataRoute = {
  role: "candidate" | "semantic" | "advisory";
  host: string;
  model: string;
  effort: string;
};
type RunEvidenceDataAdvisoryReview = null | {
  status: "completed" | "failed" | "not_run";
  assessment: null | {
    verdict: "pass" | "fail";
    overallScore: number;
    dimensions: {
      correctness: number;
      maintainability: number;
      testQuality: number;
      scopeDiscipline: number;
    };
    strengths: Array<string>;
    weaknesses: Array<string>;
    summary: string;
  };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    complete: boolean;
  };
  rawResult: {
    source: string;
    path: RunEvidenceDataFileUrl | null;
    sha256: RunEvidenceDataDigest | null;
  };
};
type RunEvidenceDataTrialEvidence = {
  caseId: string;
  trial: number;
  executionMode: "executed" | "dry" | "unknown";
  candidateDurationMs?: number | null;
  condition: {
    requested: "passive" | "enforced";
    actual: "passive" | "enforced" | "unknown";
    appliedInstrumentation: RunEvidenceDataInstrumentationList;
  };
  observationCompleteness: "complete" | "partial" | "unavailable";
  observations: Array<{
    id: string;
    source: string;
    completeness: "complete" | "partial" | "unavailable";
    data: Record<string, unknown>;
  }>;
  metrics: Array<RunEvidenceDataMetric>;
  domainOutcomes?: Array<{
    id: string;
    status: "passed" | "failed" | "unavailable";
    detail?: string;
    evidenceRefs: Array<string>;
    data?: Record<string, unknown>;
  }>;
  taskVerdictPolicy: null | {
    id: string;
    recommendation: "passed" | "failed" | "not_assessed" | null;
  };
  advisoryReview?: RunEvidenceDataAdvisoryReview;
  routes: Array<RunEvidenceDataRoute>;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    complete: boolean;
  };
  rawResult: {
    source: string;
    path: RunEvidenceDataFileUrl | null;
    sha256: RunEvidenceDataDigest | null;
  };
  artifactRefs: Array<{
    id: string;
    path: RunEvidenceDataFileUrl;
    sha256: RunEvidenceDataDigest;
    gitExclude?: boolean;
    executable?: boolean;
  }>;
};
type RunEvidenceDataDiagnostic = { code: string; message: string };
type RunEvidenceDataMetric = { id: string; value: number | null; unit: string };
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
type ReportDataState =
  | "completed"
  | "failed"
  | "cancelled"
  | "not_run"
  | "error"
  | "unavailable"
  | "not_requested";
type ReportDataVerdict = "passed" | "failed" | "not_assessed";
type ReportDataInput = {
  resultFile: ReportDataPath;
  execution: "completed" | "failed" | "cancelled" | "not_run";
  grading: "completed" | "error" | "unavailable" | "not_requested";
  task: ReportDataVerdict;
  exitCode: 0 | 1 | 2 | 3 | 4 | 64 | 70 | 130 | 143;
  caseCount: number;
};
type ReportDataRoute = { host: string; model: string; effort: string };
type ReportDataOutcome = {
  trial: number;
  id: string;
  status: "passed" | "failed" | "unavailable";
};
type ReportDataRow = {
  resultFile: ReportDataPath;
  evidencePath: string | null;
  runId: string | null;
  caseId: string;
  execution: ReportDataState;
  grading: ReportDataState;
  task: ReportDataVerdict;
  exitCode: 0 | 1 | 2 | 3 | 4 | 64 | 70 | 130 | 143;
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
  routes: Array<{
    role: "candidate" | "semantic" | "advisory";
    host: string;
    model: string;
    effort: string;
  }>;
  domainOutcomes: Array<ReportDataOutcome>;
};
