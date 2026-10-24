import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defined,
  expectUnknown,
  fixtureCase,
  parseRunEvidence,
} from "../../fixtures/assertions";
import {
  createFixture,
  invoke,
  semanticAdapter,
} from "../../fixtures/cli-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const testDirectory = join(import.meta.dir, "../..");

const roots: string[] = [];

const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const fixture = createFixture(roots);

const advisoryAdapter = join(testDirectory, "fixtures", "advisory-adapter.ts");

test("CLI emits one JSON result and uses the task exit category", async () => {
  const { args } = await fixture();
  const passed = await invoke(args);
  expect(passed.code).toBe(0);
  expect(passed.result.task.verdict).toBe("passed");
  expect(passed.result.exitCode).toBe(0);
  expect(passed.stderr).toStartWith("sevro: effective settings ");
  expect(passed.stderr.trim().split("\n").slice(1)).toEqual([
    "sevro: preparation started",
    "sevro: preparation completed trial=1",
    "sevro: candidate started trial=1",
    "sevro: candidate completed trial=1",
    "sevro: grading started trial=1",
    "sevro: grading completed trial=1",
    "sevro: evidence started trial=1",
    "sevro: evidence completed trial=1",
    "sevro: evidence started",
    "sevro: evidence completed",
  ]);
  expectUnknown(
    parseRunEvidence(
      await readFile(defined(passed.result.evidencePath), "utf8"),
    ).result,
  ).toEqual(passed.result);
  const failed = await invoke(args, "fail");
  expect(failed.code, JSON.stringify(failed.result.diagnostic)).toBe(1);
  expect(failed.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "failed" },
    exitCode: 1,
  });
});

test("CLI reports unavailable required host evidence", async () => {
  const { args, caseFile } = await fixture();
  const definition = fixtureCase();
  definition.requiredEvidence = ["darrow.activation"];
  await writeFile(caseFile, JSON.stringify(definition));
  const missing = await invoke(args);
  expect(missing.code).toBe(4);
  expect(missing.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "unavailable" },
    task: { verdict: "not_assessed" },
  });
  const complete = await invoke(args, "observation");
  expect(complete.code).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(complete.result.evidencePath), "utf8"),
  );
  expect(defined(defined(evidence.trials[0]).observations[1])).toMatchObject({
    id: "darrow.activation",
    source: "sevro.host.synthetic",
    completeness: "complete",
  });
});

test("CLI runs semantic checks through an explicit grader route", async () => {
  const { args, caseFile } = await fixture();
  const definition = fixtureCase();
  definition.checks.push({
    id: "semantic-ready",
    grader: "sevro.semantic",
    configuration: { proposition: "The response promises readiness." },
  });
  await writeFile(caseFile, JSON.stringify(definition));
  const missing = await invoke(args);
  expect(missing.code).toBe(64);
  expect(defined(missing.result.diagnostic).message).toMatch(
    /explicit semantic host/,
  );
  const command = [...args, "--semantic-adapter-module", semanticAdapter];
  const passed = await invoke(command);
  expect(passed.code).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(passed.result.evidencePath), "utf8"),
  );
  expectUnknown(
    evidence.routes.map((route: { role: string }) => route.role),
  ).toEqual(["candidate", "semantic"]);
  expect(
    defined(defined(defined(passed.result.cases[0]).trials[0]).checks[1]),
  ).toMatchObject({
    id: "semantic-ready",
    status: "passed",
  });
  const failed = await invoke(command, "semantic-fail");
  expect(failed.code).toBe(1);
  const malformed = await invoke(command, "semantic-malformed");
  expect(malformed.code).toBe(3);
});

test("CLI selects an advisory route and retains its independent assessment", async () => {
  const { args, caseFile } = await fixture();
  const definition = fixtureCase();
  definition.fixture = {
    kind: "generated",
    commits: [
      {
        message: "Add baseline",
        files: {
          "README.md": "fixture\n",
          "app.ts": "export const value = 1;\n",
          ".agents/condition.txt": "private condition\n",
        },
      },
    ],
    files: { "app.ts": "export const value = 2;\n" },
  };
  await writeFile(caseFile, JSON.stringify(definition));
  const command = [...args, "--advisory-adapter-module", advisoryAdapter];
  const passed = await invoke(command);
  expect(passed.code).toBe(0);
  expect(passed.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(defined(passed.result.evidencePath), "utf8"),
  );
  expect(defined(evidence.routes[1])).toMatchObject({
    role: "advisory",
    host: "sevro.host.advisory-synthetic",
  });
  expect(defined(evidence.trials[0]).advisoryReview).toMatchObject({
    status: "completed",
    assessment: { verdict: "fail", overallScore: 2 },
  });
  const plain = await invoke(args);
  const plainEvidence = parseRunEvidence(
    await readFile(defined(plain.result.evidencePath), "utf8"),
  );
  expect(evidence.evaluationIdentity.digest).not.toBe(
    plainEvidence.evaluationIdentity.digest,
  );
  const conflicting = await invoke([...command, "--advisory-host", "codex"]);
  expect(conflicting.code).toBe(64);
  const invalid = await invoke([...args, "--advisory-exclude", "private.txt"]);
  expect(invalid.code).toBe(64);
});
