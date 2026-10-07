import type { CliResultData, RunEvidenceData } from "./schema-types";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { canonicalJson } from "./identity";
import { assertCliResult, assertReport, assertRunEvidence } from "./schema";

type CliResult = CliResultData;
type Evidence = RunEvidenceData;
type Case = CliResult["cases"][number];
type Trial = Case["trials"][number];

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
    ? values.reduce<number>((total, value) => total + value, 0)
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
  const result: unknown = JSON.parse(await readFile(path, "utf8"));
  assertCliResult(result);
  return result;
}

async function loadEvidence(result: CliResult): Promise<Evidence | null> {
  const path = retainedEvidencePath(result);
  if (path === null) return null;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assertRunEvidence(value);
  const evidence = value;
  if (
    evidence.runId !== result.runId ||
    canonicalJson(evidence.result) !== canonicalJson(result)
  )
    throw new Error("retained evidence differs from report result");
  return evidence;
}

function retainedEvidencePath(result: CliResult): string | null {
  if (!result.evidencePath) {
    if (result.cases.length || result.exitCode === 0)
      throw new Error("completed result has no retained evidence");
    return null;
  }
  if (!isAbsolute(result.evidencePath))
    throw new Error("evidence path must be absolute");
  return result.evidencePath;
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
  const candidateRoute = retainedCandidateRoute(evidence);
  const usage = retainedUsage(retained);
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
    ...usage,
    ...retainedIdentity(evidence),
    candidateRoute,
    domainOutcomes: selected.trials.flatMap((trial) =>
      (trial.domainOutcomes ?? []).map((outcome) => ({
        trial: trial.trial,
        id: outcome.id,
        status: outcome.status,
      })),
    ),
  };
}

function retainedCandidateRoute(
  evidence: Evidence | null,
): ReportRow["candidateRoute"] {
  if (!evidence) return null;
  const routes = evidence.routes.filter((route) => route.role === "candidate"),
    [route] = routes;
  if (routes.length !== 1 || route === undefined)
    throw new Error("retained candidate route is ambiguous");
  return { host: route.host, model: route.model, effort: route.effort };
}
function retainedUsage(retained: Evidence["trials"]) {
  const complete =
    retained.length > 0 && retained.every((trial) => trial.usage.complete);
  return {
    inputTokens: complete
      ? sumKnown(retained.map((trial) => trial.usage.inputTokens))
      : null,
    outputTokens: complete
      ? sumKnown(retained.map((trial) => trial.usage.outputTokens))
      : null,
    costUsd: complete
      ? sumKnown(retained.map((trial) => trial.usage.costUsd))
      : null,
  };
}
function retainedIdentity(evidence: Evidence | null) {
  if (!evidence)
    return {
      runnerBuildDigest: null,
      evaluationDigest: null,
      requestedCondition: null,
      actualCondition: null,
      routes: [],
    };
  return {
    runnerBuildDigest: evidence.runner.buildDigest,
    evaluationDigest: evidence.evaluationIdentity.digest,
    requestedCondition: evidence.condition.requested,
    actualCondition: evidence.condition.actual,
    routes: evidence.routes,
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
    ...report.rows.map(caseOutcomeLine),
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

function passRateCell(rate: number | null): string {
  return rate === null ? "unknown" : `${(rate * 100).toFixed(0)}%`;
}
function costCell(cost: number | null): string {
  return cost === null ? "unknown" : `$${cost.toFixed(4)}`;
}
function routeCell(route: ReportRow["candidateRoute"]): string {
  return route
    ? cell(`${route.host}/${route.model}@${route.effort}`)
    : "unknown";
}
function conditionCell(row: ReportRow): string {
  return `${row.requestedCondition ?? "unknown"} / ${row.actualCondition ?? "unknown"}`;
}
function caseOutcomeLine(row: ReportRow): string {
  return `| ${cell(row.caseId)} | ${row.task} | ${row.execution} | ${row.grading} | ${passRateCell(row.taskPassRate)} | ${seconds(row.candidateDurationMs)} | ${measured(row.inputTokens)} / ${measured(row.outputTokens)} | ${costCell(row.costUsd)} | ${conditionCell(row)} | ${routeCell(row.candidateRoute)} |`;
}

export async function reportCommand(argv: string[]): Promise<number> {
  try {
    const values = reportInvocation(argv);
    const report = await createReport(values["result-file"] ?? []);
    process.stdout.write(
      values.json ? `${JSON.stringify(report)}\n` : renderReport(report),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${reportErrorMessage(error)}\n`);
    return 64;
  }
}

function reportInvocation(argv: string[]) {
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
  return values;
}
function reportErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid report input";
}
