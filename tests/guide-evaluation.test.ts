import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guideCli, documentationRoot } from "./fixtures/documentation-tools";
import type { Scenario } from "./fixtures/guide-host";
import {
  defined,
  parseCliResult,
  parseRecord,
  record,
} from "./fixtures/assertions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function evaluate(
  host: "codex" | "claude",
  id: string,
  scenario: Scenario = "pass",
) {
  const resultsRoot = await mkdtemp(join(tmpdir(), "sevro-guide-integration-"));
  roots.push(resultsRoot);

  const run = await guideCli(
    [
      "--case-id",
      id,
      "--adapter-module",
      join(documentationRoot, "tests/fixtures/guide-host.ts"),
      "--results-root",
      resultsRoot,
      "--json",
    ],
    {
      SEVRO_GUIDE_TEST_HOST: host,
      SEVRO_GUIDE_TEST_CASE: id,
      SEVRO_GUIDE_TEST_SCENARIO: scenario,
    },
  );
  return {
    result: parseCliResult(run.stdout),
    code: run.code,
    stderr: run.stderr,
  };
}

const cases = [
  "orientation",
  "explicit",
  "unrelated",
  "missing",
  "conflict",
  "stale",
  "follow-up",
  "unauthorized",
  "extension-architecture",
  "contribution",
  "licensing",
];
const matrix = cases.flatMap((id) =>
  (["codex", "claude"] as const).map((host) => ({ id, host })),
);

test.each(matrix)(
  "Sevro executes and grades guide case $host/$id",
  async ({ host, id }) => {
    const { result } = await evaluate(host, id);
    expect(result.exitCode, result.diagnostic?.message).toBe(0);
    expect(result.execution.status).toBe("completed");
    expect(result.grading.status).toBe("completed");
    expect(result.task.verdict).toBe("passed");
    const trial = defined(defined(result.cases[0]).trials[0]);
    expect(trial.checks.every((check) => check.status === "passed")).toBe(true);
    const retained = parseRecord(
      await readFile(defined(trial.artifactPath), "utf8"),
    );
    expect(retained.format).toBe("sevro.trial-evidence.v1");
    expect(record(retained.evidence).artifactRefs).toBeDefined();
  },
  30000,
);

const negative = [
  { id: "unrelated", scenario: "effects", verdict: "failed" },
  { id: "unrelated", scenario: "changed", verdict: "failed" },
  { id: "unrelated", scenario: "missing-events", verdict: "not_assessed" },
  { id: "unrelated", scenario: "partial", verdict: "not_assessed" },
  { id: "explicit", scenario: "missing-receipt", verdict: "not_assessed" },
  { id: "explicit", scenario: "wrong-receipt", verdict: "failed" },
  { id: "follow-up", scenario: "stale-follow-up", verdict: "failed" },
  { id: "follow-up", scenario: "missing-follow-up", verdict: "not_assessed" },

  { id: "unrelated", scenario: "failed", verdict: "not_assessed" },
  { id: "orientation", scenario: "changed-mount", verdict: "failed" },
  { id: "unrelated", scenario: "extra-directory", verdict: "failed" },
  { id: "orientation", scenario: "missing-selection", verdict: "not_assessed" },
  { id: "orientation", scenario: "partial-selection", verdict: "not_assessed" },
  {
    id: "follow-up",
    scenario: "missing-continuation",
    verdict: "not_assessed",
  },
  { id: "explicit", scenario: "bad-answer", verdict: "failed" },
  { id: "stale", scenario: "bad-answer", verdict: "failed" },
  { id: "missing", scenario: "bad-answer", verdict: "failed" },
  { id: "unauthorized", scenario: "bad-answer", verdict: "failed" },
] as const;
const failures = negative.flatMap((scenario) =>
  (["codex", "claude"] as const).map((host) => ({ ...scenario, host })),
);

test.each(failures)(
  "Sevro refuses $host/$scenario guide evidence",
  async ({ host, id, scenario, verdict }) => {
    const { result } = await evaluate(host, id, scenario);
    expect(result.exitCode).not.toBe(0);
    expect(result.task.verdict).toBe(verdict);
    const retained = parseRecord(
      await readFile(defined(result.evidencePath), "utf8"),
    );
    expect(retained.format).toBe("sevro.run-evidence.v1");
  },
  30000,
);

test("Sevro guide grading accepts read-only searches with literal path globs", async () => {
  const { result } = await evaluate("codex", "unrelated", "glob-read");
  expect(result.exitCode).toBe(0);
  expect(result.task.verdict).toBe("passed");
}, 30000);

test("Guide results use Sevro built-in answer and fixture graders", async () => {
  const { result } = await evaluate("codex", "orientation");
  const trial = defined(defined(result.cases[0]).trials[0]);
  expect(
    trial.checks.some(
      (check) => check.grader === "sevro.regex" && check.status === "passed",
    ),
  ).toBe(true);
  expect(
    trial.checks.some(
      (check) => check.grader === "sevro.shell" && check.status === "passed",
    ),
  ).toBe(true);
  expect(
    trial.checks
      .filter((check) => check.grader === "sevro.guide.evidence")
      .map((check) => check.id),
  ).toEqual([
    "sevro.guide.selection",
    "sevro.guide.no-effects",
    "sevro.guide.inspected-citation",
  ]);
}, 30000);
