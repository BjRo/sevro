import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { runEvaluation, type EvaluationOptions } from "../../../src/engine";
import { defined, parseRunEvidence } from "../../fixtures/assertions";
import { wireCase } from "../../fixtures/engine-session";
import {
  createEvaluation,
  createExtensionEvaluation,
  observation,
} from "../../fixtures/evaluation-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];

const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const evaluation = createEvaluation(roots);

const extensionEvaluation = createExtensionEvaluation(evaluation);

test("extension grading can assess complete host observations when the optional final message is absent", async () => {
  const options = await extensionEvaluation();
  options.host.run = () =>
    Promise.resolve({
      finalMessage: null,
      complete: true,
      observations: [observation("example.evidence")],
    });
  const { result } = await runEvaluation(options);
  expect(result.execution.status).toBe("completed");
  expect(result.grading.status).toBe("completed");
  expect(result.task.verdict).toBe("passed");
  expect(result.exitCode).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(defined(evidence.trials[0]).rawResult.path).toBeNull();
  expect(defined(evidence.trials[0]).observationCompleteness).toBe(
    "unavailable",
  );
});

test("extension grading retains a failed check without inventing detail or evidence", async () => {
  const options = await extensionEvaluation({
    evaluate: {
      checks: [
        {
          id: "example.extension.ready",
          status: "failed",
          detail: "",
          evidenceRefs: [],
        },
      ],
      metrics: [],
    },
  });
  const { result } = await runEvaluation(options);
  expect(result.execution.status).toBe("completed");
  expect(result.grading.status).toBe("completed");
  expect(result.task.verdict).toBe("failed");
  expect(result.exitCode).toBe(1);
  expect(defined(defined(result.cases[0]).trials[0]).checks).toEqual([
    {
      id: "example.extension.ready",
      grader: "example.extension",
      status: "failed",
      evidenceRefs: [],
    },
  ]);
});

async function pairedExtensionEvaluation(
  entries: unknown[],
): Promise<EvaluationOptions> {
  return extensionEvaluation({
    resolve: {
      cases: [
        {
          ...wireCase,
          checks: [
            {
              id: "example.extension.first",
              grader: "example.extension",
              configuration: {},
            },
            {
              id: "example.extension.second",
              grader: "example.extension",
              configuration: {},
            },
          ],
        },
      ],
    },
    evaluate: { checks: entries, metrics: [] },
  });
}

test("extension grading associates two reversed results with their declared criteria", async () => {
  const options = await pairedExtensionEvaluation([
    {
      id: "example.extension.second",
      status: "failed",
      detail: "Second criterion unmet",
      evidenceRefs: ["example.evidence"],
    },
    {
      id: "example.extension.first",
      status: "passed",
      detail: "First criterion met",
      evidenceRefs: ["example.evidence"],
    },
  ]);
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
    {
      id: "example.extension.first",
      status: "passed",
      detail: "First criterion met",
    },
    {
      id: "example.extension.second",
      status: "failed",
      detail: "Second criterion unmet",
    },
  ]);
});

for (const suffix of ["unknown", "first"] as const) {
  test(`extension grading refuses a valid prefix followed by ${suffix === "first" ? "a duplicate" : "an undeclared"} ID without accepting the prefix`, async () => {
    const options = await pairedExtensionEvaluation([
      {
        id: "example.extension.first",
        status: "passed",
        evidenceRefs: ["example.evidence"],
      },
      { id: `example.extension.${suffix}`, status: "failed", evidenceRefs: [] },
    ]);
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
      message: "extension grading did not complete",
    });
    expect(defined(evidence.trials[0]).domainOutcomes).toEqual([]);
  });
}

test("retains an undeclared extension check as a grading error without assessing it", async () => {
  const options = await extensionEvaluation({
    evaluate: {
      checks: [
        {
          id: "example.extension.undeclared",
          status: "passed",
          evidenceRefs: ["example.evidence"],
        },
      ],
      metrics: [],
    },
  });
  const outcome = await runEvaluation(options);
  expect(outcome.result.execution.status).toBe("completed");
  expect(outcome.result.grading.status).toBe("error");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(outcome.result.exitCode).toBe(3);
  expect(existsSync(outcome.result.evidencePath)).toBe(true);
});
