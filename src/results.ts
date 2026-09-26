export type ExecutionStatus = "completed" | "failed" | "cancelled" | "not_run";
export type GradingStatus =
  "completed" | "error" | "unavailable" | "not_requested";
export type TaskVerdict = "passed" | "failed" | "not_assessed";

export interface CheckOutcome {
  id: string;
  grader: string;
  status: "passed" | "failed" | "unavailable";
  detail?: string;
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
  const declared = new Set(input.declaredChecks);
  if (declared.size !== input.declaredChecks.length || declared.has(""))
    throw new Error("check declarations must have unique nonempty IDs");
  const seen = new Set<string>();
  for (const check of input.checks) {
    if (!declared.has(check.id) || seen.has(check.id))
      throw new Error(`unexpected or duplicate check result: ${check.id}`);
    seen.add(check.id);
  }

  const grading: GradingStatus = input.graderError
    ? "error"
    : input.execution !== "completed"
      ? "not_requested"
      : input.requiredEvidenceUnavailable ||
          input.checks.some((check) => check.status === "unavailable") ||
          seen.size !== declared.size
        ? "unavailable"
        : declared.size === 0
          ? "not_requested"
          : "completed";
  const task: TaskVerdict =
    input.execution === "completed" &&
    input.checks.some((check) => check.status === "failed")
      ? "failed"
      : input.execution === "completed" && grading === "completed"
        ? "passed"
        : "not_assessed";
  return {
    execution: { status: input.execution },
    grading: { status: grading },
    task: { verdict: task },
  };
}

/** Apply a case's pass threshold after every required trial has an assessment. */
export function summarizeAssessments(
  assessments: Assessment[],
  passThreshold = 1,
): Assessment {
  if (!assessments.length)
    throw new Error("at least one assessment is required");
  if (
    !Number.isFinite(passThreshold) ||
    passThreshold <= 0 ||
    passThreshold > 1
  )
    throw new Error("pass threshold must be greater than zero and at most one");
  const execution: ExecutionStatus = assessments.some(
    (item) => item.execution.status === "failed",
  )
    ? "failed"
    : assessments.some((item) => item.execution.status === "cancelled")
      ? "cancelled"
      : assessments.some((item) => item.execution.status === "not_run")
        ? "not_run"
        : "completed";
  const grading: GradingStatus = assessments.some(
    (item) => item.grading.status === "error",
  )
    ? "error"
    : assessments.some((item) => item.grading.status === "unavailable")
      ? "unavailable"
      : assessments.some((item) => item.grading.status === "completed")
        ? "completed"
        : "not_requested";
  const task: TaskVerdict = assessments.some(
    (item) => item.task.verdict === "not_assessed",
  )
    ? "not_assessed"
    : assessments.filter((item) => item.task.verdict === "passed").length /
          assessments.length >=
        passThreshold
      ? "passed"
      : "failed";
  return {
    execution: { status: execution },
    grading: { status: grading },
    task: { verdict: task },
  };
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
  if (context.signal === "SIGINT") return 130;
  if (context.signal === "SIGTERM") return 143;
  if (context.internalFailure) return 70;
  if (
    assessment.execution.status === "failed" ||
    assessment.execution.status === "cancelled" ||
    (assessment.execution.status === "not_run" && !context.dryRun)
  )
    return 2;
  if (assessment.grading.status === "error") return 3;
  if (assessment.grading.status === "unavailable") return 4;
  if (assessment.task.verdict === "failed") return 1;
  return 0;
}
