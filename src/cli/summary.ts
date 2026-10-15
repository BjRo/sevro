import type { CliResultData, ReportData } from "../schema-types";

function line(value: string): string {
  return value.replaceAll(/\p{Cc}/gu, " ").slice(0, 4096);
}

function metric(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

export function displayTrialSummary(result: CliResultData): void {
  for (const selected of result.cases)
    for (const trial of selected.trials) {
      process.stdout.write(
        `trial case=${line(selected.caseId)} trial=${trial.trial} execution=${trial.execution.status} grading=${trial.grading.status} task=${trial.task.verdict}\n`,
      );
      displayFailedChecks(trial.checks);
    }
}

function displayFailedChecks(
  checks: CliResultData["cases"][number]["trials"][number]["checks"],
): void {
  for (const check of checks)
    if (check.status !== "passed")
      process.stdout.write(
        `  check=${line(check.id)} status=${check.status} reason=${line(check.detail ?? "unknown")}\n`,
      );
}

export function displayMeasurements(report: ReportData): void {
  for (const row of report.rows) {
    const duration =
      row.candidateDurationMs === null
        ? "unknown"
        : `${row.candidateDurationMs.toFixed(2)}ms`;
    const cost =
      row.costUsd === null ? "unknown" : `$${row.costUsd.toFixed(4)}`;
    process.stdout.write(
      `case=${line(row.caseId)} candidate duration=${duration} candidate tokens=${metric(row.inputTokens)}/${metric(row.outputTokens)} cost=${cost}\n`,
    );
  }
}
