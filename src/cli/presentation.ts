import { EvaluationConfigurationError } from "../engine";
import { InvocationError } from "./invocation";
import { assertCliResult } from "../schema";

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

export function display(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  const result = value as {
    execution: { status: string };
    grading: { status: string };
    task: { verdict: string };
    evidencePath: string | null;
    diagnostic?: { code: string; message: string };
    cases: Array<{
      caseId: string;
      trials: Array<{
        trial: number;
        domainOutcomes: Array<{ id: string; status: string }>;
      }>;
    }>;
  };
  process.stdout.write(
    `execution=${result.execution.status} grading=${result.grading.status} task=${result.task.verdict}\n`,
  );
  displayDomainOutcomes(result.cases);
  if (result.diagnostic?.code === "sevro.grader.error")
    process.stdout.write(`diagnostic=${result.diagnostic.message}\n`);
  if (result.evidencePath)
    process.stdout.write(`evidence=${result.evidencePath}\n`);
}

function displayDomainOutcomes(
  cases: Array<{
    caseId: string;
    trials: Array<{
      trial: number;
      domainOutcomes: Array<{ id: string; status: string }>;
    }>;
  }>,
): void {
  for (const selected of cases)
    for (const trial of selected.trials)
      for (const outcome of trial.domainOutcomes)
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
  process.exitCode = code;
}
