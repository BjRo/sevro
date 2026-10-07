import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReport, renderReport } from "../src/report";
import type { CliResultData, RunEvidenceData } from "../src/schema-types";
import {
  defined,
  parseCliResult,
  parseRunEvidence,
} from "./fixtures/assertions";

const roots: string[] = [];
const cli = join(import.meta.dir, "../src/cli.ts");
let baseline: { result: CliResultData; evidence: RunEvidenceData };
async function command(args: string[]) {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "sevro-report-quality-"));
  roots.push(root);
  return root;
}
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-report-quality-seed-"));
  try {
    const run = await command([
      "run",
      "--json",
      "--case-file",
      join(import.meta.dir, "../examples/basic/graded.json"),
      "--adapter-module",
      join(import.meta.dir, "../examples/basic/host.ts"),
      "--project-root",
      root,
      "--results-root",
      join(root, "results"),
      "--condition",
      "passive",
      "--trials",
      "1",
      "--threshold",
      "1",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = parseCliResult(run.stdout);
    baseline = {
      result,
      evidence: parseRunEvidence(
        await readFile(defined(result.evidencePath), "utf8"),
      ),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function retained() {
  const root = await temporaryRoot(),
    resultFile = join(root, "result.json"),
    evidenceFile = join(root, "evidence.json");
  const { result, evidence } = structuredClone(baseline);
  result.evidencePath = evidenceFile;
  evidence.result = result;
  return { resultFile, evidenceFile, result, evidence };
}
type Retained = Awaited<ReturnType<typeof retained>>;
async function save(fixture: Retained) {
  await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await writeFile(fixture.evidenceFile, JSON.stringify(fixture.evidence));
}

test.each([
  { paths: [] },
  { paths: ["same", "same"] },
  { paths: ["relative.json"] },
])("reports refuse invalid input file sets: %j", ({ paths }) => {
  expect(createReport([...paths])).rejects.toThrow(
    /distinct result files|must be absolute/,
  );
});
test.each(["missing", "relative"])(
  "reports refuse %s retained evidence paths",
  async (mode) => {
    const fixture = await retained();
    fixture.result.evidencePath = mode === "missing" ? null : "relative.json";
    await save(fixture);
    expect(createReport([fixture.resultFile])).rejects.toThrow(
      /no retained evidence|evidence path must be absolute/,
    );
  },
);

test.each([
  "missing-trial",
  "duplicate-trial",
  "wrong-trial",
  "wrong-run",
  "missing-route",
  "duplicate-route",
])("reports refuse inconsistent retained identities: %s", async (mode) => {
  const fixture = await retained();
  const mutations: Record<string, () => void> = {
    "missing-trial": () => {
      fixture.evidence.trials = [];
    },
    "duplicate-trial": () => {
      fixture.evidence.trials.push(
        structuredClone(defined(fixture.evidence.trials[0])),
      );
    },
    "wrong-trial": () => {
      defined(fixture.evidence.trials[0]).trial = 2;
    },
    "wrong-run": () => {
      fixture.evidence.runId = "different-run";
    },
    "missing-route": () => {
      fixture.evidence.routes = [];
    },
    "duplicate-route": () => {
      fixture.evidence.routes.push(
        structuredClone(defined(fixture.evidence.routes[0])),
      );
    },
  };
  defined(mutations[mode])();
  await save(fixture);
  expect(createReport([fixture.resultFile])).rejects.toThrow();
});

test("reports preserve measured zero while incomplete usage remains unknown", async () => {
  const measured = await retained(),
    unknown = await retained();
  const trial = defined(measured.evidence.trials[0]);
  trial.candidateDurationMs = 0;
  trial.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, complete: true };
  defined(unknown.evidence.trials[0]).usage = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    complete: false,
  };
  await save(measured);
  await save(unknown);
  const report = await createReport([measured.resultFile, unknown.resultFile]);
  expect(defined(report.rows[0])).toMatchObject({
    taskPassRate: 1,
    candidateDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  expect(defined(report.rows[1])).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  expect(renderReport(report)).toContain("100% | 0.00s | 0 / 0 | $0.0000");
  expect(renderReport(report)).toContain("unknown / unknown | unknown");
});

test("reports retain failed verdicts and independent domain outcomes", async () => {
  const fixture = await retained();
  fixture.result.task.verdict = "failed";
  const selected = defined(fixture.result.cases[0]);
  selected.task.verdict = "failed";
  defined(selected.trials[0]).task.verdict = "failed";
  defined(selected.trials[0]).domainOutcomes = [
    { id: "domain-check", status: "unavailable", evidenceRefs: [] },
  ];
  await save(fixture);
  const report = await createReport([fixture.resultFile]);
  expect(report.summary).toEqual({
    cases: 1,
    passed: 0,
    failed: 1,
    notAssessed: 0,
  });
  expect(defined(report.rows[0]).taskPassRate).toBe(0);
  expect(defined(report.rows[0]).domainOutcomes).toEqual([
    { trial: 1, id: "domain-check", status: "unavailable" },
  ]);
  expect(renderReport(report)).toContain(
    "| basic-graded | 1 | domain-check | unavailable |",
  );
  expect(renderReport(report)).toContain(
    "Domain outcomes are independent of the task verdict.",
  );
});

test("report tables escape labels and render absent measurements explicitly", async () => {
  const fixture = await retained();
  await save(fixture);
  const report = await createReport([fixture.resultFile]);
  const row = defined(report.rows[0]);
  row.caseId = "case|line\nnext";
  row.candidateRoute = null;
  row.requestedCondition = null;
  row.actualCondition = null;
  row.evidencePath = null;
  row.domainOutcomes = [
    { trial: 1, id: "domain|label\nnext", status: "unavailable" },
  ];
  expect(renderReport(report)).toContain("case\\|line next");
  expect(renderReport(report)).toContain("domain\\|label next");
  expect(renderReport(report)).toContain("unknown / unknown | unknown |");
  expect(renderReport(report)).toContain("case\\|line next: unavailable");
});

test.each([
  { args: ["report"] },
  { args: ["report", "--unknown"] },
  { args: ["report", "extra"] },
  { args: ["report", "--result-file", "relative.json"] },
])("public report CLI refuses invalid requests: %j", async ({ args }) => {
  const run = await command([...args]);
  expect(run.code).toBe(64);
  expect(run.stderr.length).toBeGreaterThan(0);
});
