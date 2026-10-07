export type ExecutionStatus = "completed" | "failed" | "cancelled" | "not_run";
export type GradingStatus =
  "completed" | "error" | "unavailable" | "not_requested";
export type TaskVerdict = "passed" | "failed" | "not_assessed";

export interface CheckOutcome {
  id: string;
  grader: string;
  status: "passed" | "failed" | "unavailable";
  detail?: string;
  evidenceRefs?: string[];
}

export interface Assessment {
  execution: { status: ExecutionStatus };
  grading: { status: GradingStatus };
  task: { verdict: TaskVerdict };
}

export interface TrialInput {
  execution: ExecutionStatus;
  declaredChecks: string[];
  checks: CheckOutcome[];
  graderError?: boolean;
  requiredEvidenceUnavailable?: boolean;
}

/** Reduce one trial without treating process completion as task success. */
export function assessTrial(input: TrialInput): Assessment {
  const { declared, seen } = validateCheckResults(input);
  const grading = trialGrading(input, declared.size, seen.size);
  const task = trialVerdict(input, grading);
  return {
    execution: { status: input.execution },
    grading: { status: grading },
    task: { verdict: task },
  };
}

function validateCheckResults(input: TrialInput) {
  const declared = new Set(input.declaredChecks);
  validateCheckDeclarations(input.declaredChecks, declared);
  const seen = new Set<string>();
  for (const check of input.checks) {
    if (!declared.has(check.id) || seen.has(check.id))
      throw new Error(`unexpected or duplicate check result: ${check.id}`);
    seen.add(check.id);
  }

  return { declared, seen };
}

function trialGrading(
  input: TrialInput,
  declared: number,
  seen: number,
): GradingStatus {
  if (input.graderError) return "error";
  if (input.execution !== "completed") return "not_requested";
  if (evidenceUnavailable(input, declared, seen)) return "unavailable";
  return declared === 0 ? "not_requested" : "completed";
}

function evidenceUnavailable(
  input: TrialInput,
  declared: number,
  seen: number,
): boolean {
  return (
    Boolean(input.requiredEvidenceUnavailable) ||
    input.checks.some((check) => check.status === "unavailable") ||
    seen !== declared
  );
}

function trialVerdict(input: TrialInput, grading: GradingStatus): TaskVerdict {
  if (input.execution !== "completed") return "not_assessed";
  if (input.checks.some((check) => check.status === "failed")) return "failed";
  return grading === "completed" ? "passed" : "not_assessed";
}

/** Apply an explicitly selected policy only to a fully assessed trial. */
export function applyTaskVerdictPolicy(
  assessment: Assessment,
  recommendation: TaskVerdict | null,
  selected: boolean,
): Assessment {
  if (!selected) return assessment;
  if (
    recommendation === null ||
    assessment.execution.status !== "completed" ||
    assessment.grading.status !== "completed"
  )
    return { ...assessment, task: { verdict: "not_assessed" } };
  return { ...assessment, task: { verdict: recommendation } };
}

/** Apply a case's pass threshold after every required trial has an assessment. */
export function summarizeAssessments(
  assessments: Assessment[],
  passThreshold = 1,
): Assessment {
  validateSummaryInputs(assessments, passThreshold);
  const execution = summaryExecution(assessments);
  const grading = summaryGrading(assessments);
  const task = summaryVerdict(assessments, passThreshold);
  return {
    execution: { status: execution },
    grading: { status: grading },
    task: { verdict: task },
  };
}

function validateSummaryInputs(
  assessments: Assessment[],
  passThreshold: number,
): void {
  if (!assessments.length)
    throw new Error("at least one assessment is required");
  if (
    !Number.isFinite(passThreshold) ||
    passThreshold <= 0 ||
    passThreshold > 1
  )
    throw new Error("pass threshold must be greater than zero and at most one");
}

function summaryExecution(assessments: Assessment[]): ExecutionStatus {
  const priority: ExecutionStatus[] = ["failed", "cancelled", "not_run"];
  return (
    priority.find((status) =>
      assessments.some((item) => item.execution.status === status),
    ) ?? "completed"
  );
}

function summaryGrading(assessments: Assessment[]): GradingStatus {
  const priority: GradingStatus[] = ["error", "unavailable", "completed"];
  return (
    priority.find((status) =>
      assessments.some((item) => item.grading.status === status),
    ) ?? "not_requested"
  );
}

function summaryVerdict(
  assessments: Assessment[],
  passThreshold: number,
): TaskVerdict {
  if (assessments.some((item) => item.task.verdict === "not_assessed"))
    return "not_assessed";
  const passed = assessments.filter(
    (item) => item.task.verdict === "passed",
  ).length;
  return passed / assessments.length >= passThreshold ? "passed" : "failed";
}

/** Combine case verdicts after each case has applied its own threshold. */
export function summarizeCases(cases: Assessment[]): Assessment {
  const summary = summarizeAssessments(cases);
  if (cases.some((item) => item.task.verdict === "failed"))
    return { ...summary, task: { verdict: "failed" } };
  return summary;
}

export interface ExitContext {
  signal?: "SIGINT" | "SIGTERM";
  internalFailure?: boolean;
  dryRun?: boolean;
}

/** Resolve the documented CLI exit category without discarding detailed states. */
export function exitCodeFor(
  assessment: Assessment,
  context: ExitContext = {},
): number {
  const interruption = interruptionExit(context);
  if (interruption !== null) return interruption;
  if (executionFailed(assessment.execution.status, context)) return 2;
  const gradingCodes: Partial<Record<GradingStatus, number>> = {
    error: 3,
    unavailable: 4,
  };
  return gradingCodes[assessment.grading.status] ?? taskExitCode(assessment);
}

function interruptionExit(context: ExitContext): number | null {
  if (context.signal === "SIGINT") return 130;
  if (context.signal === "SIGTERM") return 143;
  return context.internalFailure ? 70 : null;
}

function executionFailed(
  status: ExecutionStatus,
  context: ExitContext,
): boolean {
  return (
    status === "failed" ||
    status === "cancelled" ||
    (status === "not_run" && !context.dryRun)
  );
}

function taskExitCode(assessment: Assessment): number {
  return assessment.task.verdict === "failed" ? 1 : 0;
}

function validateCheckDeclarations(ids: string[], declared: Set<string>): void {
  if (declared.size !== ids.length || declared.has(""))
    throw new Error("check declarations must have unique nonempty IDs");
}
