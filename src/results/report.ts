import {
  type CliResultData,
  type ReportData,
  type RunEvidenceData,
  assertCliResult,
  assertReport,
  assertRunEvidence,
} from "../schema/index";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonicalJson } from "../kernel/index";
import { canonicalRuntimeRoot } from "../runtime/index";
import { nativeTranscriptRetention } from "./transcript-retention";

type CliResult = CliResultData;
type Evidence = RunEvidenceData;
type Case = CliResult["cases"][number];
type Trial = Case["trials"][number];

export type ReportRow = ReportData["rows"][number];
/**
 * A row always derives from retained evidence: a result with cases cannot omit
 * it, so a row's evidence path, conditions, route and transcripts are known.
 */
type RetainedRow = ReportRow & {
  evidencePath: string;
  requestedCondition: NonNullable<ReportRow["requestedCondition"]>;
  actualCondition: NonNullable<ReportRow["actualCondition"]>;
  candidateRoute: NonNullable<ReportRow["candidateRoute"]>;
  nativeTranscripts: NonNullable<ReportRow["nativeTranscripts"]>;
};
type RetainedReport = Omit<ReportData, "rows"> & { rows: RetainedRow[] };

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

async function loadEvidence(
  result: CliResult,
): Promise<{ path: string; evidence: Evidence } | null> {
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
  return { path, evidence };
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

function trialEvidence(caseId: string, trials: Trial[], evidence: Evidence) {
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
  retainedEvidence: { path: string; evidence: Evidence },
  transcripts: Awaited<ReturnType<typeof nativeTranscriptRetention>>,
): RetainedRow {
  const { evidence } = retainedEvidence;
  const retained = trialEvidence(selected.caseId, selected.trials, evidence);
  const candidateRoute = retainedCandidateRoute(evidence);
  const usage = retainedUsage(retained);
  return {
    resultFile: path,
    evidencePath: retainedEvidence.path,
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
    nativeTranscripts: {
      retained: transcripts.filter(
        (item) => item.caseId === selected.caseId && !item.pruned,
      ).length,
      pruned: transcripts.filter(
        (item) => item.caseId === selected.caseId && item.pruned,
      ).length,
    },
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
  evidence: Evidence,
): RetainedRow["candidateRoute"] {
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
function retainedIdentity(evidence: Evidence) {
  return {
    runnerBuildDigest: evidence.runner.buildDigest,
    evaluationDigest: evidence.evaluationIdentity.digest,
    requestedCondition: evidence.condition.requested,
    actualCondition: evidence.condition.actual,
    routes: evidence.routes,
  };
}

/** Only a result without cases may lack retained evidence, so it has no rows. */
async function resultRows(
  path: string,
  result: CliResult,
): Promise<RetainedRow[]> {
  const retained = await loadEvidence(result);
  if (!retained) return [];
  const transcripts = await nativeTranscriptRetention(retained.evidence);
  return result.cases.map((selected) =>
    reportRow(path, result, selected, retained, transcripts),
  );
}

export async function createReport(paths: string[]): Promise<RetainedReport> {
  if (!paths.length || new Set(paths).size !== paths.length)
    throw new Error("report needs distinct result files");
  const rows: RetainedRow[] = [];
  const inputs: ReportData["inputs"] = [];
  for (const path of paths) {
    const result = await loadResult(path);
    rows.push(...(await resultRows(path, result)));
    inputs.push({
      resultFile: path,
      execution: result.execution.status,
      grading: result.grading.status,
      task: result.task.verdict,
      exitCode: result.exitCode,
      caseCount: result.cases.length,
    });
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

export function renderReport(report: RetainedReport): string {
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
      (row) =>
        `- ${cell(row.caseId)}: ${row.evidencePath}${transcriptSummary(row)}`,
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

function transcriptSummary(row: RetainedRow): string {
  return `; native transcripts: ${row.nativeTranscripts.retained} retained, ${row.nativeTranscripts.pruned} pruned`;
}

function passRateCell(rate: number | null): string {
  return rate === null ? "unknown" : `${(rate * 100).toFixed(0)}%`;
}
function costCell(cost: number | null): string {
  return cost === null ? "unknown" : `$${cost.toFixed(4)}`;
}
function routeCell(route: RetainedRow["candidateRoute"]): string {
  return cell(`${route.host}/${route.model}@${route.effort}`);
}
function conditionCell(row: RetainedRow): string {
  return `${row.requestedCondition} / ${row.actualCondition}`;
}
function caseOutcomeLine(row: RetainedRow): string {
  return `| ${cell(row.caseId)} | ${row.task} | ${row.execution} | ${row.grading} | ${passRateCell(row.taskPassRate)} | ${seconds(row.candidateDurationMs)} | ${measured(row.inputTokens)} / ${measured(row.outputTokens)} | ${costCell(row.costUsd)} | ${conditionCell(row)} | ${routeCell(row.candidateRoute)} |`;
}

export async function reportCommand(argv: string[]): Promise<number> {
  try {
    const values = reportInvocation(argv);
    const report = await createReport(await reportPaths(values));
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
      latest: { type: "boolean" },
      "results-root": { type: "string" },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== "report")
    throw new Error("expected the report command");
  return values;
}

async function reportPaths(
  values: ReturnType<typeof reportInvocation>,
): Promise<string[]> {
  validateReportSource(values);
  const paths = selectedReportPaths(values);
  if (paths.some((path) => !path.trim()))
    throw new Error("--result-file must name a readable retained result file");
  return Promise.all(paths.map((path) => canonicalRuntimeRoot(resolve(path))));
}

function validateReportSource(
  values: ReturnType<typeof reportInvocation>,
): void {
  if (values.latest && values["result-file"] !== undefined)
    throw new Error("--latest and --result-file are exclusive");
  if (values["results-root"] !== undefined && !values.latest)
    throw new Error("--results-root requires --latest");
}

function selectedReportPaths(
  values: ReturnType<typeof reportInvocation>,
): string[] {
  return values.latest
    ? [
        join(
          values["results-root"] ?? join(process.cwd(), ".sevro", "results"),
          "latest.json",
        ),
      ]
    : (values["result-file"] ?? []);
}
function reportErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid report input";
}
