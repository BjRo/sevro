import { expect, test } from "bun:test";
import {
  assessTrial,
  exitCodeFor,
  summarizeAssessments,
  summarizeCases,
  type Assessment,
} from "../src/results";

const checked = (status: "passed" | "failed" | "unavailable") => ({
  id: "answer",
  grader: "sevro.regex",
  status,
});

for (const { name, checks } of [
  { name: "foreign ID", checks: [{ ...checked("passed"), id: "other" }] },
  { name: "duplicate ID", checks: [checked("passed"), checked("passed")] },
]) {
  test(`trial assessment refuses a ${name} without accepting its passing checks`, () => {
    expect(() =>
      assessTrial({
        execution: "completed",
        declaredChecks: ["answer"],
        checks,
      }),
    ).toThrow("unexpected or duplicate check result:");
  });
}

for (const { name, declarations } of [
  { name: "an empty ID", declarations: [""] },
  { name: "a repeated ID", declarations: ["answer", "answer"] },
]) {
  test(`trial assessment refuses ${name} in its declared criteria`, () => {
    expect(() =>
      assessTrial({
        execution: "completed",
        declaredChecks: declarations,
        checks: [],
      }),
    ).toThrow("check declarations must have unique nonempty IDs");
  });
}

test("assessment summary refuses an empty trial set", () => {
  expect(() => summarizeAssessments([])).toThrow(
    "at least one assessment is required",
  );
});

for (const { name, threshold } of [
  { name: "NaN", threshold: Number.NaN },
  { name: "positive infinity", threshold: Number.POSITIVE_INFINITY },
  { name: "negative infinity", threshold: Number.NEGATIVE_INFINITY },
  { name: "zero", threshold: 0 },
  { name: "a negative fraction", threshold: -0.1 },
  { name: "above one", threshold: 1.1 },
]) {
  test(`assessment summary refuses a threshold of ${name}`, () => {
    const passed = assessTrial({
      execution: "completed",
      declaredChecks: ["answer"],
      checks: [checked("passed")],
    });
    expect(() => summarizeAssessments([passed], threshold)).toThrow(
      "pass threshold must be greater than zero and at most one",
    );
  });
}

test("prompt-only and dry runs do not claim task success", () => {
  const prompt = assessTrial({
    execution: "completed",
    declaredChecks: [],
    checks: [],
  });
  expect(prompt.grading.status).toBe("not_requested");
  expect(prompt.task.verdict).toBe("not_assessed");
  expect(exitCodeFor(prompt)).toBe(0);

  const dry = assessTrial({
    execution: "not_run",
    declaredChecks: ["answer"],
    checks: [],
  });
  expect(dry.task.verdict).toBe("not_assessed");
  expect(exitCodeFor(dry, { dryRun: true })).toBe(0);
});

test("failed checks are distinct from grading and execution failures", () => {
  const failed = assessTrial({
    execution: "completed",
    declaredChecks: ["answer"],
    checks: [checked("failed")],
  });
  expect(failed).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "failed" },
  });
  expect(exitCodeFor(failed)).toBe(1);

  const executionFailure = assessTrial({
    execution: "failed",
    declaredChecks: ["answer"],
    checks: [],
  });
  expect(executionFailure.task.verdict).toBe("not_assessed");
  expect(exitCodeFor(executionFailure)).toBe(2);
});

test("missing evidence and grader errors cannot pass", () => {
  const unavailable = assessTrial({
    execution: "completed",
    declaredChecks: ["answer"],
    checks: [checked("unavailable")],
  });
  expect(unavailable.grading.status).toBe("unavailable");
  expect(unavailable.task.verdict).toBe("not_assessed");
  expect(exitCodeFor(unavailable)).toBe(4);

  const errored = assessTrial({
    execution: "completed",
    declaredChecks: ["answer"],
    checks: [],
    graderError: true,
  });
  expect(errored.grading.status).toBe("error");
  expect(errored.task.verdict).toBe("not_assessed");
  expect(exitCodeFor(errored)).toBe(3);
});

test("a case threshold applies only to fully assessed trials", () => {
  const pass = assessTrial({
    execution: "completed",
    declaredChecks: ["answer"],
    checks: [checked("passed")],
  });
  const fail = assessTrial({
    execution: "completed",
    declaredChecks: ["answer"],
    checks: [checked("failed")],
  });
  expect(summarizeAssessments([pass, fail], 0.5).task.verdict).toBe("passed");
  expect(summarizeAssessments([pass, fail], 1).task.verdict).toBe("failed");

  const unavailable = assessTrial({
    execution: "completed",
    declaredChecks: ["answer"],
    checks: [],
  });
  const summary = summarizeAssessments([pass, unavailable], 0.5);
  expect(summary.task.verdict).toBe("not_assessed");
  expect(exitCodeFor(summary)).toBe(4);
  expect(
    summarizeCases([summarizeAssessments([pass, fail], 0.5)]).task.verdict,
  ).toBe("passed");
  expect(
    summarizeCases([summarizeAssessments([fail]), summary]).task.verdict,
  ).toBe("failed");
});

test("exit precedence preserves the most severe operational failure", () => {
  const mixed: Assessment = summarizeAssessments([
    assessTrial({
      execution: "completed",
      declaredChecks: ["answer"],
      checks: [checked("failed")],
    }),
    assessTrial({
      execution: "failed",
      declaredChecks: ["answer"],
      checks: [],
    }),
  ]);
  expect(mixed.execution.status).toBe("failed");
  expect(mixed.task.verdict).toBe("not_assessed");
  expect(exitCodeFor(mixed)).toBe(2);
  expect(exitCodeFor(mixed, { internalFailure: true })).toBe(70);
  expect(exitCodeFor(mixed, { signal: "SIGINT" })).toBe(130);
  expect(exitCodeFor(mixed, { signal: "SIGTERM" })).toBe(143);
});
