import { expectUnknown } from "./fixtures/assertions";
import {
  defined,
  parseCliResult,
  parseReport,
  parseRunEvidence,
} from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createReport, renderReport } from "../src/report";
import { assertReport } from "../src/schema";
const roots: string[] = [];
const repository = resolve(import.meta.dir, "..");
const cli = join(repository, "src/cli.ts");
const host = join(repository, "examples/basic/host.ts");
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function command(argv: string[]) {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sevro-report-"));
  roots.push(root);
  const paths: string[] = [];
  for (const [name, file, dry] of [
    ["graded", "graded.json", false],
    ["prompt", "prompt-only.json", false],
    ["dry", "graded.json", true],
  ] as const) {
    const run = await command([
      process.execPath,
      cli,
      "run",
      "--json",
      "--case-file",
      join(repository, "examples/basic", file),
      "--adapter-module",
      host,
      "--project-root",
      root,
      "--results-root",
      join(root, name),
      "--condition",
      "passive",
      "--trials",
      "1",
      "--threshold",
      "1",
      ...(dry ? ["--dry"] : []),
    ]);
    expect(run.code, run.stderr).toBe(0);
    const path = join(root, `${name}.json`);
    await writeFile(path, run.stdout);
    paths.push(path);
  }
  return { root, paths };
}
test("report keeps measured task outcomes separate from dry and prompt-only runs", async () => {
  const { paths } = await fixture();
  const report = await createReport(paths);
  assertReport(report);
  expectUnknown(report.summary).toEqual({
    cases: 3,
    passed: 1,
    failed: 0,
    notAssessed: 2,
  });
  expectUnknown(report.rows.map((row) => row.taskPassRate)).toEqual([
    1,
    null,
    null,
  ]);
  expect(defined(report.rows[0])).toMatchObject({
    caseId: "basic-graded",
    execution: "completed",
    grading: "completed",
    task: "passed",
    requestedCondition: "passive",
    candidateRoute: {
      host: "sevro.host.example",
      model: "deterministic-example",
      effort: "none",
    },
  });
  expect(
    defined(defined(report.rows[0])).candidateDurationMs,
  ).toBeGreaterThanOrEqual(0);
  expect(defined(defined(report.rows[0])).inputTokens).toBeNull();
  expect(defined(defined(report.rows[0])).costUsd).toBeNull();
  expect(defined(defined(report.rows[2])).candidateDurationMs).toBeNull();
  expect(renderReport(report)).toContain("unknown");
});
test("public report command emits versioned JSON and readable rows", async () => {
  const { paths } = await fixture();
  const json = await command([
    process.execPath,
    cli,
    "report",
    "--json",
    ...paths.flatMap((path) => ["--result-file", path]),
  ]);
  expect(json.code, json.stderr).toBe(0);
  const parsed = parseReport(json.stdout);
  assertReport(parsed);
  expect(parsed.rows).toHaveLength(3);
  const human = await command([
    process.execPath,
    cli,
    "report",
    "--result-file",
    defined(defined(paths[0])),
  ]);
  expect(human.code, human.stderr).toBe(0);
  expect(human.stdout).toContain(
    "| basic-graded | passed | completed | completed |",
  );
});
test("report rejects inconsistent evidence and keeps historical duration unknown", async () => {
  const { paths } = await fixture();
  const result = parseCliResult(
    await readFile(defined(defined(paths[0])), "utf8"),
  );
  const evidence = parseRunEvidence(
    await readFile(defined(result.evidencePath), "utf8"),
  );
  delete defined(evidence.trials[0]).candidateDurationMs;
  await writeFile(defined(result.evidencePath), JSON.stringify(evidence));
  expect(
    defined(defined((await createReport([defined(defined(paths[0]))])).rows[0]))
      .candidateDurationMs,
  ).toBeNull();
  result.task.verdict = "failed";
  await writeFile(defined(defined(paths[0])), JSON.stringify(result));
  expect(createReport([defined(defined(paths[0]))])).rejects.toThrow();
});
test("report keeps a pre-run invocation failure visible without a case row", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-report-error-"));
  roots.push(root);
  const failed = await command([process.execPath, cli, "run", "--json"]);
  expect(failed.code).toBe(64);
  const path = join(root, "failed.json");
  await writeFile(path, failed.stdout);
  const report = await createReport([path]);
  expect(report.rows).toHaveLength(0);
  expect(defined(report.inputs[0])).toMatchObject({
    exitCode: 64,
    execution: "not_run",
    grading: "not_requested",
    task: "not_assessed",
  });
  expect(renderReport(report)).toContain(
    "| 64 | not_run | not_requested | not_assessed | 0 |",
  );
});
