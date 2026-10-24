import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runEvaluation, type HostAdapter } from "../../src/engine";
import {
  checkoutRunner,
  defined,
  expectUnknown,
  parseRunEvidence,
} from "../fixtures/assertions";
import { baseCase, digest, rootsForRun } from "../fixtures/engine";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("runs trials, applies threshold, and retains evidence before fixture cleanup", async () => {
  const paths = await rootsForRun(roots);
  const workspaces: string[] = [];
  let call = 0;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run({ workspace }) {
      workspaces.push(workspace);
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
        "fixture content\n",
      );
      call++;
      return { finalMessage: call === 1 ? "ready" : "wait", complete: true };
    },
  };
  const outcome = await runEvaluation({
    ...paths,
    case: baseCase,
    host,
    runnerBuildDigest: digest,
    runnerCheckoutRoot: resolve(import.meta.dir, "../.."),
    projectDigest: digest,
    condition: "passive",
    trialCount: 2,
    jobs: 1,
    passThreshold: 0.5,
  });
  expect(outcome.result).toMatchObject({
    format: "sevro.cli-result.v1",
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "passed" },
    exitCode: 0,
  });
  expectUnknown(
    defined(outcome.result.cases[0]).trials.map((trial) => trial.task.verdict),
  ).toEqual(["passed", "failed"]);
  expect(existsSync(defined(workspaces[0]))).toBe(false);
  expect(existsSync(defined(workspaces[1]))).toBe(true);
  roots.push(defined(workspaces[1]));
  for (const trial of defined(defined(outcome.result.cases[0])).trials)
    expect(existsSync(trial.artifactPath)).toBe(true);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expect(evidence.format).toBe("sevro.run-evidence.v1");
  expect(evidence.trials).toHaveLength(2);
  expect(evidence.evaluationIdentity.dimensions.condition).toBe("passive");
  expect(evidence.runner).toMatchObject({
    source: "checkout",
    buildDigest: digest,
  });
  expect(checkoutRunner(evidence.runner).root).toMatch(/^file:\/\//);
  expect(checkoutRunner(evidence.runner).revision).toMatch(/^[a-f0-9]{40,64}$/);
  expect(
    checkoutRunner(evidence.runner).dirtyPatchDigest === null ||
      /^[a-f0-9]{64}$/.test(
        defined(checkoutRunner(evidence.runner).dirtyPatchDigest),
      ),
  ).toBeTrue();
  expectUnknown(defined(evidence.trials[0]).usage).toEqual({
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    complete: false,
  });
  expect(
    evidence.trials.every((trial) => defined(trial.candidateDurationMs) >= 0),
  ).toBeTrue();
  expectUnknown(evidence.result).toEqual(outcome.result);
});

test("renders the workspace token separately for each trial", async () => {
  const paths = await rootsForRun(roots);
  const seen: string[] = [];
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run({ prompt, workspace }) {
      expect(prompt).toBe(`Inspect ${workspace} and ${workspace}`);
      seen.push(workspace);
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  const outcome = await runEvaluation({
    ...paths,
    case: {
      ...baseCase,
      prompt: "Inspect {{sevro.workspace}} and {{sevro.workspace}}",
    },
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 2,
    passThreshold: 1,
  });
  expect(outcome.result.exitCode).toBe(0);
  expect(seen).toHaveLength(2);
  expect(defined(seen[0])).not.toBe(defined(seen[1]));
});

test("routes a rendered continuation only to a capable host", async () => {
  const paths = await rootsForRun(roots);
  const prompts: string[] = [];
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    hostCapabilities: ["sevro.host.continuation"],
    model: "synthetic-v1",
    effort: "none",
    run({ prompt, followUpPrompt, workspace }) {
      expect(prompt).toBe(`Inspect ${workspace}`);
      expect(followUpPrompt).toBe(`Continue in ${workspace}`);
      prompts.push(defined(followUpPrompt));
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  const selectedCase = {
    ...baseCase,
    prompt: "Inspect {{sevro.workspace}}",
    followUpPrompt: "Continue in {{sevro.workspace}}",
  };
  const result = await runEvaluation({
    ...paths,
    case: selectedCase,
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(result.result.exitCode).toBe(0);
  expect(prompts).toHaveLength(1);
  expect(
    runEvaluation({
      ...paths,
      case: selectedCase,
      host: { ...host, hostCapabilities: [] },
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    }),
  ).rejects.toThrow(/does not support continuation/);
});

test("dry preparation records every trial without executing the host", async () => {
  const paths = await rootsForRun(roots);
  let hostCalls = 0;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      hostCalls++;
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  const options = {
    ...paths,
    case: baseCase,
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 2,
    passThreshold: 1,
  };
  const dry = await runEvaluation({ ...options, dry: true });
  expect(hostCalls).toBe(0);
  expect(dry.result).toMatchObject({
    execution: { status: "not_run" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
    exitCode: 0,
  });
  expect(defined(dry.result.cases[0]).trials).toHaveLength(2);
  const dryEvidence = parseRunEvidence(
    await readFile(dry.result.evidencePath, "utf8"),
  );
  expectUnknown(
    dryEvidence.trials.map(
      (trial: { executionMode: string }) => trial.executionMode,
    ),
  ).toEqual(["dry", "dry"]);
  expectUnknown(
    dryEvidence.trials.map((trial) => trial.candidateDurationMs),
  ).toEqual([null, null]);
  expect(defined(dryEvidence.trials[0]).rawResult.path).toBeNull();
  const executed = await runEvaluation(options);
  expect(hostCalls).toBe(2);
  const executedEvidence = parseRunEvidence(
    await readFile(executed.result.evidencePath, "utf8"),
  );
  expect(dryEvidence.evaluationIdentity.digest).not.toBe(
    executedEvidence.evaluationIdentity.digest,
  );
});

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("required host observations fail closed when missing or incomplete", async () => {
  const paths = await rootsForRun(roots);
  const evalCase = {
    ...baseCase,
    requiredEvidence: ["darrow.activation"],
  };
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      return Promise.resolve({
        finalMessage: "ready",
        complete: true,
        observations: [
          {
            id: "darrow.activation",
            completeness: "complete" as const,
            data: { selected: "darrow.tdd" },
          },
        ],
      });
    },
  };
  const options = {
    ...paths,
    case: evalCase,
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const passed = await runEvaluation(options);
  expect(passed.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(passed.result.evidencePath, "utf8"),
  );
  expect(defined(defined(evidence.trials[0]).observations[1])).toMatchObject({
    id: "darrow.activation",
    source: host.id,
    completeness: "complete",
  });
  const missing = await runEvaluation({
    ...options,
    host: {
      ...host,
      run() {
        return Promise.resolve({ finalMessage: "ready", complete: true });
      },
    },
  });
  expect(missing.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "unavailable" },
    task: { verdict: "not_assessed" },
    exitCode: 4,
  });
  const partial = await runEvaluation({
    ...options,
    host: {
      ...host,
      run() {
        return Promise.resolve({
          finalMessage: "ready",
          complete: true,
          observations: [
            {
              id: "darrow.activation",
              completeness: "partial" as const,
              data: {},
            },
          ],
        });
      },
    },
  });
  expect(partial.result.exitCode).toBe(4);
  const invalid = await runEvaluation({
    ...options,
    host: {
      ...host,
      run() {
        return Promise.resolve({
          finalMessage: "ready",
          complete: true,
          observations: [
            {
              id: "sevro.observation.final-message",
              completeness: "complete" as const,
              data: {},
            },
          ],
        });
      },
    },
  });
  expect(invalid.result.execution.status).toBe("failed");
  expect(invalid.result.task.verdict).toBe("not_assessed");
});

test("host artifacts are retained per trial and can satisfy required evidence", async () => {
  const paths = await rootsForRun(roots);
  let call = 0;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      call++;
      return Promise.resolve({
        finalMessage: "ready",
        complete: true,
        artifacts: [
          {
            id: "example.host.trace",
            bytes: Buffer.from(`trace ${call}\n`),
          },
        ],
      });
    },
  };
  const options = {
    ...paths,
    case: { ...baseCase, requiredEvidence: ["example.host.trace"] },
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 2,
    jobs: 1,
    passThreshold: 1,
  };
  const outcome = await runEvaluation(options);
  expect(outcome.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const refs = evidence.trials.map(
    (trial: {
      artifactRefs: {
        id: string;
        path: string;
      }[];
    }) => trial.artifactRefs.find((item) => item.id === "example.host.trace"),
  );
  expect(defined(refs[0]).path).not.toBe(defined(refs[1]).path);
  expect(await readFile(new URL(defined(refs[0]).path), "utf8")).toBe(
    "trace 1\n",
  );
  expect(await readFile(new URL(defined(refs[1]).path), "utf8")).toBe(
    "trace 2\n",
  );
  const missing = await runEvaluation({
    ...options,
    host: {
      ...host,
      run() {
        return Promise.resolve({ finalMessage: "ready", complete: true });
      },
    },
  });
  expect(missing.result.grading.status).toBe("unavailable");
  expect(missing.result.exitCode).toBe(4);
  const invalid = await runEvaluation({
    ...options,
    host: {
      ...host,
      run() {
        return Promise.resolve({
          finalMessage: "ready",
          complete: true,
          artifacts: [{ id: "../outside", bytes: Buffer.from("bad") }],
        });
      },
    },
  });
  expect(invalid.result.execution.status).toBe("failed");
  expect(invalid.result.task.verdict).toBe("not_assessed");
});
