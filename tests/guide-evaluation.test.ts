import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateGuide } from "../scripts/guide/evaluation";
import { guideHost, type Scenario } from "./fixtures/guide-host";
import { defined, parseRecord, record } from "./fixtures/assertions";

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
  return evaluateGuide(id, guideHost(host, id, scenario), { resultsRoot });
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
    expect(result.exitCode).toBe(0);
    expect(result.execution.status).toBe("completed");
    expect(result.grading.status).toBe("completed");
    expect(result.task.verdict).toBe("passed");
    const trial = defined(defined(result.cases[0]).trials[0]);
    expect(trial.checks.every((check) => check.status === "passed")).toBe(true);
    const retained = parseRecord(await readFile(trial.artifactPath, "utf8"));
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
    const retained = parseRecord(await readFile(result.evidencePath, "utf8"));
    expect(retained.format).toBe("sevro.run-evidence.v1");
  },
  30000,
);

test("Sevro guide grading accepts read-only searches with literal path globs", async () => {
  const { result } = await evaluate("codex", "unrelated", "glob-read");
  expect(result.exitCode).toBe(0);
  expect(result.task.verdict).toBe("passed");
}, 30000);

test("Sevro materializes guide fixtures without evaluator cases or graders", async () => {
  const resultsRoot = await mkdtemp(
    join(tmpdir(), "sevro-guide-hidden-checks-"),
  );
  roots.push(resultsRoot);
  const host = guideHost("claude", "conflict");
  const run = host.run.bind(host);
  let workspace = "";
  host.run = async (request) => {
    workspace = request.workspace;
    expect(
      await Bun.file(
        join(workspace, ".agents/skills/sevro-guide/evals/cases.json"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(join(workspace, "scripts/guide/grading.ts")).exists(),
    ).toBe(false);
    expect(await Bun.file(join(workspace, "README.md")).text()).toContain(
      "@example/sevro-cloud",
    );
    expect(await Bun.file(join(workspace, "package.json")).text()).toContain(
      "@bjoernrochel/sevro",
    );
    expect(
      (await Bun.file(
        join(workspace, ".claude/settings.json"),
      ).json()) as unknown,
    ).toMatchObject({
      permissions: {
        deny: [
          "Edit",
          "Write",
          "Bash",
          "Agent",
          "Task",
          "WebFetch",
          "WebSearch",
        ],
      },
    });
    return run(request);
  };
  const { result } = await evaluateGuide("conflict", host, { resultsRoot });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(join(workspace, "README.md")).exists()).toBe(false);
}, 30000);
