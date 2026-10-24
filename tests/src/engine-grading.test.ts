import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runEvaluation, type HostAdapter } from "../../src/engine";
import {
  arrayContaining,
  defined,
  expectUnknown,
  objectContaining,
  parseRunEvidence,
} from "../fixtures/assertions";
import { baseCase, digest, rootsForRun } from "../fixtures/engine";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("semantic checks use an isolated grader route and retain verdict evidence", async () => {
  const paths = await rootsForRun(roots);
  const evalCase = {
    ...baseCase,
    checks: [
      ...baseCase.checks,
      {
        id: "promise",
        grader: "sevro.semantic",
        configuration: { proposition: "The response promises readiness." },
      },
    ],
  };
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "candidate-v1",
    effort: "none",
    run() {
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  let semanticCalls = 0;
  const semanticHost: HostAdapter = {
    id: "sevro.host.semantic",
    model: "grader-v1",
    effort: "low",
    async run({ prompt, workspace }) {
      semanticCalls++;
      expect(prompt).toContain("The response promises readiness.");
      expect(await Bun.file(join(workspace, "README.md")).exists()).toBeFalse();
      return {
        finalMessage:
          '{"checks":[{"id":"promise","verdict":"pass","reason":"Ready is stated"}]}',
        complete: true,
        inputTokens: 10,
        outputTokens: 4,
        usageComplete: true,
        artifacts: [
          { id: "example.trace", bytes: Buffer.from("grader trace\n") },
        ],
      };
    },
  };
  const options = {
    ...paths,
    case: evalCase,
    host,
    semanticHost,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const passed = await runEvaluation(options);
  expect(semanticCalls).toBe(1);
  expect(passed.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(passed.result.evidencePath, "utf8"),
  );
  expectUnknown(
    evidence.routes.map((route: { role: string }) => route.role),
  ).toEqual(["candidate", "semantic"]);
  expectUnknown(defined(evidence.trials[0]).observations).toEqual(
    arrayContaining([
      objectContaining({
        source: semanticHost.id,
        data: { verdict: "pass", reason: "Ready is stated" },
      }),
    ]),
  );
  const artifacts = defined(evidence.trials[0]).artifactRefs;
  const raw = artifacts.find(
    (item: { id: string }) => item.id === "sevro.semantic.verdicts",
  );
  const trace = artifacts.find(
    (item: { id: string }) => item.id === "sevro.semantic.example.trace",
  );
  expect(await readFile(new URL(defined(raw).path), "utf8")).toContain(
    '"id":"promise"',
  );
  expect(await readFile(new URL(defined(trace).path), "utf8")).toBe(
    "grader trace\n",
  );
  expect(
    runEvaluation({ ...options, semanticHost: undefined }),
  ).rejects.toThrow(/explicit semantic host/);
  const incomplete = await runEvaluation({
    ...options,
    host: {
      ...host,
      run() {
        return Promise.resolve({ finalMessage: null, complete: false });
      },
    },
  });
  expect(semanticCalls).toBe(1);
  expect(incomplete.result.grading.status).toBe("unavailable");
  expect(
    defined(defined(defined(incomplete.result.cases[0]).trials[0]).checks[0])
      .status,
  ).toBe("unavailable");
  const malformed = await runEvaluation({
    ...options,
    semanticHost: {
      ...semanticHost,
      run() {
        return Promise.resolve({ finalMessage: "invalid", complete: true });
      },
    },
  });
  expect(malformed.result.grading.status).toBe("error");
  expect(malformed.result.exitCode).toBe(3);
  const failed = await runEvaluation({
    ...options,
    semanticHost: {
      ...semanticHost,
      run() {
        return Promise.resolve({
          finalMessage:
            '{"checks":[{"id":"promise","verdict":"fail","reason":"No promise"}]}',
          complete: true,
        });
      },
    },
  });
  expect(failed.result.task.verdict).toBe("failed");
});

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("advisory review inspects a blind change and cannot alter task grading", async () => {
  const paths = await rootsForRun(roots);
  const evalCase = {
    ...baseCase,
    fixture: {
      kind: "generated" as const,
      commits: [
        {
          message: "Add baseline",
          files: {
            "app.ts": "export const value = 1;\n",
            ".agents/condition.txt": "hidden condition\n",
          },
        },
      ],
    },
  };
  const host: HostAdapter = {
    id: "sevro.host.candidate",
    model: "candidate-v1",
    effort: "none",
    async run({ workspace }) {
      await writeFile(join(workspace, "app.ts"), "export const value = 2;\n");
      await writeFile(
        join(workspace, "new-test.ts"),
        "test('value', () => {});\n",
      );
      return { finalMessage: "ready", complete: true };
    },
  };
  let reviewCalls = 0;
  const advisoryHost: HostAdapter = {
    id: "sevro.host.advisory",
    model: "reviewer-v1",
    effort: "high",
    async run({ prompt, workspace }) {
      reviewCalls++;
      expect(prompt).toContain("Deterministic checks");
      expect(await readFile(join(workspace, "app.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(
        await Bun.file(join(workspace, "new-test.ts")).exists(),
      ).toBeTrue();
      expect(
        await Bun.file(join(workspace, ".agents", "condition.txt")).exists(),
      ).toBeFalse();
      return {
        finalMessage: JSON.stringify({
          verdict: "fail",
          overallScore: 2,
          dimensions: {
            correctness: 2,
            maintainability: 3,
            testQuality: 2,
            scopeDiscipline: 4,
          },
          strengths: ["Small change"],
          weaknesses: ["Missing validation"],
          summary: "The implementation has a correctness gap.",
        }),
        complete: true,
        inputTokens: 40,
        outputTokens: 20,
        usageComplete: true,
        artifacts: [
          { id: "review.trace", bytes: Buffer.from("review trace\n") },
        ],
      };
    },
  };
  const options = {
    ...paths,
    case: evalCase,
    host,
    advisoryHost,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const passed = await runEvaluation(options);
  expect(reviewCalls).toBe(1);
  expect(passed.result.task.verdict).toBe("passed");
  expect(passed.result.exitCode).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(passed.result.evidencePath, "utf8"),
  );
  expectUnknown(
    evidence.routes.map((route: { role: string }) => route.role),
  ).toEqual(["candidate", "advisory"]);
  expect(defined(evidence.trials[0]).advisoryReview).toMatchObject({
    status: "completed",
    assessment: { verdict: "fail", overallScore: 2 },
    usage: { inputTokens: 40, outputTokens: 20, complete: true },
  });
  const raw = defined(defined(evidence.trials[0]).advisoryReview).rawResult;
  expect(await readFile(new URL(defined(raw.path)), "utf8")).toContain(
    '"verdict":"fail"',
  );
  const trace = defined(evidence.trials[0]).artifactRefs.find(
    (item: { id: string }) => item.id === "sevro.advisory.review.trace",
  );
  expect(await readFile(new URL(defined(trace).path), "utf8")).toBe(
    "review trace\n",
  );
  const malformed = await runEvaluation({
    ...options,
    advisoryHost: {
      ...advisoryHost,
      run() {
        return Promise.resolve({ finalMessage: "invalid", complete: true });
      },
    },
  });
  expect(malformed.result.task.verdict).toBe("passed");
  const failedEvidence = parseRunEvidence(
    await readFile(malformed.result.evidencePath, "utf8"),
  );
  expect(defined(defined(failedEvidence.trials[0]).advisoryReview).status).toBe(
    "failed",
  );
  expect(
    defined(defined(failedEvidence.trials[0]).advisoryReview).assessment,
  ).toBeNull();
  const rejected = await runEvaluation({
    ...options,
    advisoryHost: {
      ...advisoryHost,
      run() {
        return Promise.reject(new Error("private reviewer failure"));
      },
    },
  });
  expect(rejected.result.task.verdict).toBe("passed");
  const rejectedEvidence = parseRunEvidence(
    await readFile(rejected.result.evidencePath, "utf8"),
  );
  expect(
    defined(defined(rejectedEvidence.trials[0]).advisoryReview).status,
  ).toBe("failed");
  const dry = await runEvaluation({ ...options, dry: true });
  const dryEvidence = parseRunEvidence(
    await readFile(dry.result.evidencePath, "utf8"),
  );
  expect(defined(defined(dryEvidence.trials[0]).advisoryReview).status).toBe(
    "not_run",
  );
  expect(reviewCalls).toBe(1);
  expect(runEvaluation({ ...options, case: baseCase })).rejects.toThrow(
    /Git fixture/,
  );
  expect(
    runEvaluation({ ...options, advisoryExcludedPaths: [".git/config"] }),
  ).rejects.toThrow(/advisory exclusion/);
});
