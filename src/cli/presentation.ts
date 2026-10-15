import { EvaluationConfigurationError } from "../engine";
import { InvocationError } from "./invocation";
import { assertCliResult } from "../schema";
import type { ReportData } from "../schema-types";
import { displayMeasurements, displayTrialSummary } from "./summary";

function failure(code: 64 | 70, message: string) {
  const result = {
    format: "sevro.cli-result.v1",
    runId: null,
    execution: { status: "not_run" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
    exitCode: code,
    evidencePath: null,
    cases: [],
    diagnostic: {
      code: code === 64 ? "sevro.invocation.invalid" : "sevro.runner.error",
      message: message.slice(0, 4096),
    },
  };
  assertCliResult(result);
  return result;
}

export function display(
  result: unknown,
  json: boolean,
  completion?: { resultFile: string; report: ReportData },
): void {
  assertCliResult(result);
  if (result.diagnostic)
    process.stderr.write(`sevro: ${result.diagnostic.message}\n`);
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(
    `execution=${result.execution.status} grading=${result.grading.status} task=${result.task.verdict}\n`,
  );
  displayTrialSummary(result);
  displayDomainOutcomes(result.cases);
  if (completion) {
    displayMeasurements(completion.report);
    process.stdout.write(`result=${completion.resultFile}\n`);
  }
  if (result.evidencePath)
    process.stdout.write(`evidence=${result.evidencePath}\n`);
}

function displayDomainOutcomes(
  cases: Array<{
    caseId: string;
    trials: Array<{
      trial: number;
      domainOutcomes?: Array<{ id: string; status: string }>;
    }>;
  }>,
): void {
  for (const selected of cases)
    for (const trial of selected.trials)
      for (const outcome of trial.domainOutcomes ?? [])
        process.stdout.write(
          `domain case=${selected.caseId} trial=${trial.trial} outcome=${outcome.id} status=${outcome.status}\n`,
        );
}

export function runnerFailureCategory(error: unknown): 64 | 70 {
  return error instanceof EvaluationConfigurationError ||
    error instanceof InvocationError
    ? 64
    : 70;
}

export function displayFailure(
  error: unknown,
  json: boolean,
  code: 64 | 70,
  fallback: string,
): void {
  display(
    failure(code, error instanceof Error ? error.message : fallback),
    json,
  );
  process.stderr.write(
    code === 64
      ? "Correct the named option or input and retry. Run sevro run --help for examples and required options.\n"
      : "Check the reported path and ensure --results-root and --run-state-root are writable directories, then retry.\n",
  );
  process.exitCode = code;
}
