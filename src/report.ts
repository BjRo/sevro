import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { canonicalJson } from "./identity";
import { assertCliResult, assertReport, assertRunEvidence } from "./schema";

type State = { status: string };
type Verdict = { verdict: string };
type DomainOutcome = { id: string; status: string };
type Trial = {
  trial: number;
  execution: State;
  grading: State;
  task: Verdict;
  domainOutcomes?: DomainOutcome[];
};
type Case = {
  caseId: string;
  execution: State;
  grading: State;
  task: Verdict;
  trials: Trial[];
};
type CliResult = {
  format: string;
  runId: string | null;
  execution: State;
  grading: State;
  task: Verdict;
  exitCode: number;
  evidencePath: string | null;
  cases: Case[];
};
type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  complete: boolean;
};
type TrialEvidence = {
  caseId: string;
  trial: number;
  executionMode: string;
  candidateDurationMs?: number | null;
  usage: Usage;
};
type Evidence = {
  runId: string;
  result: CliResult;
  runner: { buildDigest: string };
  evaluationIdentity: { digest: string };
  condition: { requested: string; actual: string };
  routes: Array<{ role: string; host: string; model: string; effort: string }>;
  trials: TrialEvidence[];
};

export type ReportRow = {
  resultFile: string;
  evidencePath: string | null;
  runId: string | null;
  caseId: string;
  execution: string;
  grading: string;
  task: string;
  exitCode: number;
  trialCount: number;
  taskPassRate: number | null;
  candidateDurationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  runnerBuildDigest: string | null;
  evaluationDigest: string | null;
  requestedCondition: string | null;
  actualCondition: string | null;
  candidateRoute: { host: string; model: string; effort: string } | null;
  routes: Array<{ role: string; host: string; model: string; effort: string }>;
  domainOutcomes: Array<{ trial: number; id: string; status: string }>;
};

function sumKnown(values: Array<number | null | undefined>): number | null {
  return values.length && values.every((value) => value != null)
    ? values.reduce<number>((total, value) => total + value!, 0)
    : null;
}

function passRate(trials: Trial[]): number | null {
  if (
    !trials.length ||
    trials.some(
      (trial) =>
        trial.execution.status !== "completed" ||
        trial.grading.status !== "completed" ||
        trial.task.verdict === "not_assessed",
    )
  )
    return null;
  return (
    trials.filter((trial) => trial.task.verdict === "passed").length /
    trials.length
  );
}

async function loadResult(path: string) {
  if (!isAbsolute(path))
    throw new Error("report result paths must be absolute");
  const result = JSON.parse(await readFile(path, "utf8")) as unknown;
  assertCliResult(result);
  return result as CliResult;
}

async function loadEvidence(result: CliResult): Promise<Evidence | null> {
  if (!result.evidencePath) {
    if (result.cases.length || result.exitCode === 0)
      throw new Error("completed result has no retained evidence");
    return null;
  }
  if (!isAbsolute(result.evidencePath))
    throw new Error("evidence path must be absolute");
  const value = JSON.parse(
    await readFile(result.evidencePath, "utf8"),
  ) as unknown;
  assertRunEvidence(value);
  const evidence = value as Evidence;
  if (
    evidence.runId !== result.runId ||
    canonicalJson(evidence.result) !== canonicalJson(result)
  )
    throw new Error("retained evidence differs from report result");
  return evidence;
}

function trialEvidence(
  caseId: string,
  trials: Trial[],
  evidence: Evidence | null,
) {
  if (!evidence) return [];
  const matching = evidence.trials.filter((item) => item.caseId === caseId);
  if (
    matching.length !== trials.length ||
    trials.some(
      (trial) =>
        matching.filter((item) => item.trial === trial.trial).length !== 1,
    )
  )
    throw new Error("retained trial evidence differs from report result");
  return matching;
}

function reportRow(
  path: string,
  result: CliResult,
  selected: Case,
  evidence: Evidence | null,
): ReportRow {
  const retained = trialEvidence(selected.caseId, selected.trials, evidence);
  const candidateRoutes =
    evidence?.routes.filter((route) => route.role === "candidate") ?? [];
  if (evidence && candidateRoutes.length !== 1)
    throw new Error("retained candidate route is ambiguous");
  const completeUsage =
    retained.length > 0 && retained.every((trial) => trial.usage.complete);
  const route = candidateRoutes[0];
  return {
    resultFile: path,
    evidencePath: result.evidencePath,
    runId: result.runId,
    caseId: selected.caseId,
    execution: selected.execution.status,
    grading: selected.grading.status,
    task: selected.task.verdict,
    exitCode: result.exitCode,
    trialCount: selected.trials.length,
    taskPassRate: passRate(selected.trials),
    candidateDurationMs: sumKnown(
      retained.map((trial) => trial.candidateDurationMs),
    ),
    inputTokens: completeUsage
      ? sumKnown(retained.map((trial) => trial.usage.inputTokens))
      : null,
    outputTokens: completeUsage
      ? sumKnown(retained.map((trial) => trial.usage.outputTokens))
      : null,
    costUsd: completeUsage
      ? sumKnown(retained.map((trial) => trial.usage.costUsd))
      : null,
    runnerBuildDigest: evidence?.runner.buildDigest ?? null,
    evaluationDigest: evidence?.evaluationIdentity.digest ?? null,
    requestedCondition: evidence?.condition.requested ?? null,
    actualCondition: evidence?.condition.actual ?? null,
    candidateRoute: route
      ? { host: route.host, model: route.model, effort: route.effort }
      : null,
    routes: evidence?.routes ?? [],
    domainOutcomes: selected.trials.flatMap((trial) =>
      (trial.domainOutcomes ?? []).map((outcome) => ({
        trial: trial.trial,
        id: outcome.id,
        status: outcome.status,
      })),
    ),
  };
}

export async function createReport(paths: string[]) {
  if (!paths.length || new Set(paths).size !== paths.length)
    throw new Error("report needs distinct result files");
  const rows: ReportRow[] = [];
  const inputs: Array<{
    resultFile: string;
    execution: string;
    grading: string;
    task: string;
    exitCode: number;
    caseCount: number;
  }> = [];
  for (const path of paths) {
    const result = await loadResult(path);
    const evidence = await loadEvidence(result);
    inputs.push({
      resultFile: path,
      execution: result.execution.status,
      grading: result.grading.status,
      task: result.task.verdict,
      exitCode: result.exitCode,
      caseCount: result.cases.length,
    });
    for (const selected of result.cases)
      rows.push(reportRow(path, result, selected, evidence));
  }
  const report = {
    format: "sevro.report.v1",
    inputs,
    rows,
    summary: {
      cases: rows.length,
      passed: rows.filter((row) => row.task === "passed").length,
      failed: rows.filter((row) => row.task === "failed").length,
      notAssessed: rows.filter((row) => row.task === "not_assessed").length,
    },
  };
  assertReport(report);
  return report;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/[\r\n]/g, " ");
}

function measured(value: number | null, digits = 0): string {
  return value === null ? "unknown" : value.toFixed(digits);
}

function seconds(value: number | null): string {
  return value === null ? "unknown" : `${(value / 1000).toFixed(2)}s`;
}

export function renderReport(
  report: Awaited<ReturnType<typeof createReport>>,
): string {
  const lines = [
    "# Sevro evaluation report",
    "",
    "Task verdict, execution, and grading are separate. Unknown measurements are not zero. Rows do not claim matched comparisons.",
    "",
    `Cases: ${report.summary.cases}; passed: ${report.summary.passed}; failed: ${report.summary.failed}; not assessed: ${report.summary.notAssessed}.`,
    "",
    "## Input runs",
    "",
    "| Result file | Exit | Execution | Grading | Task | Cases |",
    "| --- | ---: | --- | --- | --- | ---: |",
    ...report.inputs.map(
      (input) =>
        `| ${cell(input.resultFile)} | ${input.exitCode} | ${input.execution} | ${input.grading} | ${input.task} | ${input.caseCount} |`,
    ),
    "",
    "## Case outcomes",
    "",
    "| Case | Task | Execution | Grading | Pass rate | Candidate time | Candidate tokens | Candidate cost | Condition | Candidate route |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...report.rows.map(
      (row) =>
        `| ${cell(row.caseId)} | ${row.task} | ${row.execution} | ${row.grading} | ${row.taskPassRate === null ? "unknown" : `${(row.taskPassRate * 100).toFixed(0)}%`} | ${seconds(row.candidateDurationMs)} | ${measured(row.inputTokens)} / ${measured(row.outputTokens)} | ${row.costUsd === null ? "unknown" : `$${row.costUsd.toFixed(4)}`} | ${row.requestedCondition ?? "unknown"} / ${row.actualCondition ?? "unknown"} | ${row.candidateRoute ? cell(`${row.candidateRoute.host}/${row.candidateRoute.model}@${row.candidateRoute.effort}`) : "unknown"} |`,
    ),
    "",
    "## Retained evidence",
    "",
    ...report.rows.map(
      (row) => `- ${cell(row.caseId)}: ${row.evidencePath ?? "unavailable"}`,
    ),
    "",
  ];
  const outcomes = report.rows.flatMap((row) =>
    row.domainOutcomes.map((outcome) => ({ caseId: row.caseId, ...outcome })),
  );
  if (outcomes.length)
    lines.push(
      "## Domain outcomes",
      "",
      "Domain outcomes are independent of the task verdict.",
      "",
      "| Case | Trial | Outcome | Status |",
      "| --- | ---: | --- | --- |",
      ...outcomes.map(
        (outcome) =>
          `| ${cell(outcome.caseId)} | ${outcome.trial} | ${cell(outcome.id)} | ${outcome.status} |`,
      ),
      "",
    );
  lines.push(
    "## Routes",
    "",
    "| Case | Role | Host | Model | Effort |",
    "| --- | --- | --- | --- | --- |",
    ...report.rows.flatMap((row) =>
      row.routes.map(
        (route) =>
          `| ${cell(row.caseId)} | ${route.role} | ${cell(route.host)} | ${cell(route.model)} | ${cell(route.effort)} |`,
      ),
    ),
    "",
  );
  return lines.join("\n");
}

export async function reportCommand(argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        "result-file": { type: "string", multiple: true },
      },
    });
    if (positionals.length !== 1 || positionals[0] !== "report")
      throw new Error("expected the report command");
    const report = await createReport(values["result-file"] ?? []);
    process.stdout.write(
      values.json ? `${JSON.stringify(report)}\n` : renderReport(report),
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "invalid report input"}\n`,
    );
    return 64;
  }
}
