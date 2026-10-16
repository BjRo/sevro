import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guideCli, documentationRoot } from "./documentation-tools";
import type { Scenario } from "./guide-host";
import { defined, parseCliResult, parseRecord, record } from "./assertions";

type Host = "codex" | "claude";

function guideEvaluator(host: Host) {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });
  return (id: string, scenario?: Scenario) =>
    evaluate(roots, host, id, scenario);
}

async function evaluate(
  roots: string[],
  host: Host,
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
export function registerGuideCases(host: Host) {
  const evaluate = guideEvaluator(host);
  test.each(cases.map((id) => ({ id, host })))(
    "Sevro executes and grades guide case $host/$id",
    async ({ id }) => {
      const { result } = await evaluate(id);
      expect(result.exitCode, result.diagnostic?.message).toBe(0);
      expect(result.execution.status).toBe("completed");
      expect(result.grading.status).toBe("completed");
      expect(result.task.verdict).toBe("passed");
      const trial = defined(defined(result.cases[0]).trials[0]);
      expect(trial.checks.every((check) => check.status === "passed")).toBe(
        true,
      );
      const retained = parseRecord(
        await readFile(defined(trial.artifactPath), "utf8"),
      );
      expect(retained.format).toBe("sevro.trial-evidence.v1");
      expect(record(retained.evidence).artifactRefs).toBeDefined();
    },
    30000,
  );
  return evaluate;
}

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
export function registerGuideFailures(host: Host) {
  const evaluate = guideEvaluator(host);
  test.each(negative.map((scenario) => ({ ...scenario, host })))(
    "Sevro refuses $host/$scenario guide evidence",
    async ({ id, scenario, verdict }) => {
      const { result } = await evaluate(id, scenario);
      expect(result.exitCode).not.toBe(0);
      expect(result.task.verdict).toBe(verdict);
      const retained = parseRecord(
        await readFile(defined(result.evidencePath), "utf8"),
      );
      expect(retained.format).toBe("sevro.run-evidence.v1");
    },
    30000,
  );
}
