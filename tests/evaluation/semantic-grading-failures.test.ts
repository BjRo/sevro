import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { runEvaluation, type EvaluationOptions } from "../../src/engine";
import { defined, parseRecord, parseRunEvidence } from "../fixtures/assertions";
import { requireSemantic } from "../fixtures/evaluation-fixtures";
import { createEvaluation } from "../fixtures/evaluation-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const evaluation = createEvaluation(roots);

async function semanticPairEvaluation(
  entries: unknown[],
): Promise<EvaluationOptions> {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  options.case.checks = [
    {
      id: "first",
      grader: "sevro.semantic",
      configuration: { proposition: "The first criterion is met." },
    },
    {
      id: "second",
      grader: "sevro.semantic",
      configuration: { proposition: "The second criterion is met." },
    },
  ];
  options.semanticHost = {
    id: "example.semantic",
    model: "fixture",
    effort: "none",
    run: () =>
      Promise.resolve({
        finalMessage: JSON.stringify({ checks: entries }),
        complete: true,
      }),
  };
  return options;
}

test("semantic grading associates two reversed verdicts with their declared criteria", async () => {
  const entries = [
    { id: "second", verdict: "fail", reason: "Second criterion unmet" },
    { id: "first", verdict: "pass", reason: "First criterion met" },
  ];
  const options = await semanticPairEvaluation(entries);
  const { result } = await runEvaluation(options);
  expect(result.execution.status).toBe("completed");
  expect(result.grading.status).toBe("completed");
  expect(result.task.verdict).toBe("failed");
  expect(result.exitCode).toBe(1);
  expect(
    defined(defined(result.cases[0]).trials[0]).checks.map(
      ({ id, status, detail }) => ({ id, status, detail }),
    ),
  ).toEqual([
    { id: "first", status: "passed", detail: "First criterion met" },
    { id: "second", status: "failed", detail: "Second criterion unmet" },
  ]);
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (item) => item.id === "sevro.semantic.verdicts",
    ),
  );
  expect(parseRecord(await readFile(new URL(artifact.path), "utf8"))).toEqual({
    checks: entries,
  });
});

for (const id of ["unknown", "first"] as const) {
  test(`semantic grading refuses a valid prefix followed by ${id === "first" ? "a duplicate" : "an unknown"} ID without accepting the prefix`, async () => {
    const entries = [
      { id: "first", verdict: "pass", reason: "First criterion met" },
      { id, verdict: "fail", reason: "Later invalid identifier" },
    ];
    const options = await semanticPairEvaluation(entries);
    const { result } = await runEvaluation(options);
    expect(result.execution.status).toBe("completed");
    expect(result.grading.status).toBe("error");
    expect(result.task.verdict).toBe("not_assessed");
    expect(result.exitCode).toBe(3);
    expect(defined(defined(result.cases[0]).trials[0]).checks).toEqual([]);
    const evidence = parseRunEvidence(
      await readFile(result.evidencePath, "utf8"),
    );
    expect(evidence.diagnostic).toEqual({
      code: "sevro.grader.error",
      message: "semantic grading did not complete",
    });
    expect(
      defined(evidence.trials[0]).observations.filter(
        (item) =>
          item.source === "example.semantic" &&
          Object.hasOwn(item.data, "verdict"),
      ),
    ).toEqual([]);
    const artifact = defined(
      defined(evidence.trials[0]).artifactRefs.find(
        (item) => item.id === "sevro.semantic.verdicts",
      ),
    );
    expect(parseRecord(await readFile(new URL(artifact.path), "utf8"))).toEqual(
      { checks: entries },
    );
  });
}

for (const candidate of [
  { name: "absent", finalMessage: null, complete: true },
  { name: "partial", finalMessage: "ready", complete: false },
]) {
  test(`keeps semantic grading unavailable for a ${candidate.name} candidate without calling the grader`, async () => {
    const options = await evaluation(candidate);
    requireSemantic(options, { finalMessage: "unused", complete: true });
    let calls = 0;
    options.semanticHost = {
      ...defined(options.semanticHost),
      run() {
        calls++;
        return Promise.resolve({ finalMessage: "unused", complete: true });
      },
    };
    const outcome = await runEvaluation(options);
    expect(calls).toBe(0);
    expect(outcome.result.execution.status).toBe("completed");
    expect(outcome.result.grading.status).toBe("unavailable");
    expect(outcome.result.task.verdict).toBe("not_assessed");
    expect(outcome.result.exitCode).toBe(4);
    expect(
      defined(defined(outcome.result.cases[0]).trials[0]).checks,
    ).toMatchObject([
      { id: "meaning", status: "unavailable", evidenceRefs: [] },
    ]);
  });
}

test("refuses a failed semantic host even when its output contains a passing verdict", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const verdict =
    '{"checks":[{"id":"meaning","verdict":"pass","reason":"Ready is stated"}]}';
  requireSemantic(options, {
    finalMessage: verdict,
    complete: true,
    executionFailed: true,
    artifacts: [
      { id: "example.trace", bytes: Buffer.from("failed grader trace") },
    ],
  });
  const outcome = await runEvaluation(options);
  expect(outcome.result.execution.status).toBe("completed");
  expect(outcome.result.grading.status).toBe("error");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(outcome.result.exitCode).toBe(3);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  const raw = defined(
    trial.artifactRefs.find((item) => item.id === "sevro.semantic.verdicts"),
  );
  expect(await readFile(new URL(raw.path), "utf8")).toBe(verdict);
  const trace = defined(
    trial.artifactRefs.find(
      (item) => item.id === "sevro.semantic.example.trace",
    ),
  );
  expect(await readFile(new URL(trace.path), "utf8")).toBe(
    "failed grader trace",
  );
});

for (const response of [
  { name: "absent", finalMessage: null, retained: false, accepted: false },
  {
    name: "exactly 1 MiB",
    finalMessage:
      '{"checks":[{"id":"meaning","verdict":"pass","reason":"Ready"}]}'.padEnd(
        1024 * 1024,
        " ",
      ),
    retained: true,
    accepted: true,
  },
  {
    name: "above 1 MiB",
    finalMessage:
      '{"checks":[{"id":"meaning","verdict":"pass","reason":"Ready"}]}'.padEnd(
        1024 * 1024 + 1,
        " ",
      ),
    retained: false,
    accepted: false,
  },
] as const) {
  test(`semantic grading bounds raw verdict retention for ${response.name} output`, async () => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    requireSemantic(options, {
      finalMessage: response.finalMessage,
      complete: true,
      artifacts: [{ id: "example.trace", bytes: Buffer.from("grader trace") }],
    });
    let workspace = "";
    const host = defined(options.semanticHost);
    options.semanticHost = {
      ...host,
      run(request) {
        workspace = request.workspace;
        return host.run(request);
      },
    };
    const { result } = await runEvaluation(options);
    expect(result.execution.status).toBe("completed");
    expect(result.grading.status).toBe(
      response.accepted ? "completed" : "error",
    );
    expect(result.task.verdict).toBe(
      response.accepted ? "passed" : "not_assessed",
    );
    const checks = defined(defined(result.cases[0]).trials[0]).checks;
    const evidence = parseRunEvidence(
      await readFile(result.evidencePath, "utf8"),
    );
    if (response.accepted) {
      expect(result.exitCode).toBe(0);
      expect(checks).toMatchObject([{ id: "meaning", status: "passed" }]);
      expect(evidence.diagnostic).toBeUndefined();
    } else {
      expect(result.exitCode).toBe(3);
      expect(checks).toEqual([]);
      expect(evidence.diagnostic).toMatchObject({ code: "sevro.grader.error" });
    }
    const trial = defined(evidence.trials[0]);
    const raw = trial.artifactRefs.find(
      (item) => item.id === "sevro.semantic.verdicts",
    );
    if (response.retained) {
      expect(await readFile(new URL(defined(raw).path), "utf8")).toBe(
        response.finalMessage,
      );
    } else {
      expect(raw).toBeUndefined();
    }
    const trace = defined(
      trial.artifactRefs.find(
        (item) => item.id === "sevro.semantic.example.trace",
      ),
    );
    expect(await readFile(new URL(trace.path), "utf8")).toBe("grader trace");
    expect(workspace).not.toBe("");
    expect(existsSync(workspace)).toBe(!response.accepted);
    roots.push(workspace);
  });
}

for (const grader of [
  { name: "malformed", finalMessage: "{broken", complete: true },
  { name: "incomplete", finalMessage: '{"verdicts":[]}', complete: false },
]) {
  test(`retains ${grader.name} semantic output and its workspace for grading-error inspection`, async () => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    requireSemantic(options, grader);
    let workspace = "";
    const host = defined(options.semanticHost);
    options.semanticHost = {
      ...host,
      run(request) {
        workspace = request.workspace;
        return host.run(request);
      },
    };
    const outcome = await runEvaluation(options);
    expect(outcome.result.execution.status).toBe("completed");
    expect(outcome.result.grading.status).toBe("error");
    expect(outcome.result.task.verdict).toBe("not_assessed");
    expect(outcome.result.exitCode).toBe(3);
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    const raw = defined(
      defined(evidence.trials[0]).artifactRefs.find(
        (item) => item.id === "sevro.semantic.verdicts",
      ),
    );
    expect(await readFile(new URL(raw.path), "utf8")).toBe(grader.finalMessage);
    expect(workspace).not.toBe("");
    expect(existsSync(workspace)).toBe(true);
    roots.push(workspace);
  });
}

const semanticDocuments: {
  name: string;
  path: string;
  files: Record<string, string>;
}[] = [
  { name: "missing", path: "answer.md", files: {} },
  {
    name: "ambiguous",
    path: "*.md",
    files: { "first.md": "ready", "second.md": "ready" },
  },
  {
    name: "oversized",
    path: "answer.md",
    files: { "answer.md": "x".repeat(64 * 1024 + 1) },
  },
];

for (const artifact of semanticDocuments) {
  test(`refuses ${artifact.name} semantic documents without calling the grader`, async () => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    options.case.fixture = { files: artifact.files };
    requireSemantic(options, { finalMessage: "unused", complete: true });
    defined(options.case.checks[0]).configuration.artifactPath = artifact.path;
    let calls = 0;
    options.semanticHost = {
      ...defined(options.semanticHost),
      run() {
        calls++;
        return Promise.resolve({ finalMessage: "unused", complete: true });
      },
    };
    const outcome = await runEvaluation(options);
    expect(calls).toBe(0);
    expect(outcome.result.grading.status).toBe("error");
    expect(outcome.result.task.verdict).toBe("not_assessed");
    expect(outcome.result.exitCode).toBe(3);
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    const raw = defined(defined(evidence.trials[0]).rawResult.path);
    expect(await readFile(new URL(raw), "utf8")).toBe("ready");
  });
}
