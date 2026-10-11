import { expectUnknown } from "./fixtures/assertions";
import {
  arrayContaining,
  checkoutRunner,
  defined,
  objectContaining,
  parseCheckpoint,
  parseRecord,
  parseRunEvidence,
} from "./fixtures/assertions";
import { afterEach, test, expect, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runEvaluation, type HostAdapter } from "../src/engine";
const roots: string[] = [];
const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function rootsForRun() {
  const root = await mkdtemp(join(tmpdir(), "sevro-engine-test-"));
  roots.push(root);
  return { projectRoot: root, resultsRoot: join(root, "results") };
}
const digest = "a".repeat(64);
async function waitForIsolationMarker(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("isolation barrier timed out");
    await Bun.sleep(10);
  }
}
/** Keep the advanced retention clock away from other runs' temporary data. */
async function runRetentionInIsolation(pattern: string): Promise<boolean> {
  if (process.env.SEVRO_RETENTION_TEST_ISOLATED === "1") return false;
  const scope = await mkdtemp(join(tmpdir(), "sevro-retention-test-"));
  const argv = [
    process.execPath,
    "test",
    import.meta.path,
    "--test-name-pattern",
    pattern,
  ];
  const command =
    process.platform === "linux"
      ? [
          "/usr/bin/bwrap",
          "--unshare-user",
          "--bind",
          "/",
          "/",
          "--dev-bind",
          "/dev",
          "/dev",
          "--proc",
          "/proc",
          "--tmpfs",
          "/var/tmp",
          "--",
          ...argv,
        ]
      : argv;
  try {
    const child = Bun.spawn(command, {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        TMPDIR: scope,
        SEVRO_RETENTION_TEST_ISOLATED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, out + err).toBe(0);
    return true;
  } finally {
    await rm(scope, { recursive: true, force: true });
  }
}
const baseCase = {
  id: "answer",
  prompt: "Return ready.",
  fixture: { files: { "README.md": "fixture content\n" } },
  checks: [
    {
      id: "response",
      grader: "sevro.regex" as const,
      configuration: { pattern: "^ready$" },
    },
  ],
  requiredEvidence: [],
};
function failedRetentionOptions(
  paths: { projectRoot: string; resultsRoot: string },
  observeWorkspace: (workspace: string) => void,
) {
  return {
    ...paths,
    case: baseCase,
    host: {
      id: "example.failure",
      model: "synthetic",
      effort: "none",
      run(request: Parameters<HostAdapter["run"]>[0]) {
        observeWorkspace(request.workspace);
        return Promise.resolve({
          finalMessage: null,
          complete: false,
          executionFailed: true,
        });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
}
test("runs trials, applies threshold, and retains evidence before fixture cleanup", async () => {
  const paths = await rootsForRun();
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
    runnerCheckoutRoot: resolve(import.meta.dir, ".."),
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
  const paths = await rootsForRun();
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
  const paths = await rootsForRun();
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
  const paths = await rootsForRun();
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
  const paths = await rootsForRun();
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
  const paths = await rootsForRun();
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
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("semantic checks use an isolated grader route and retain verdict evidence", async () => {
  const paths = await rootsForRun();
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
  const paths = await rootsForRun();
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
test("host failure retains completed trials and reports execution failure", async () => {
  const paths = await rootsForRun();
  let call = 0;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      call++;
      if (call === 2) return Promise.reject(new Error("private host failure"));
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  const outcome = await runEvaluation({
    ...paths,
    case: baseCase,
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 3,
    jobs: 1,
    passThreshold: 0.5,
  });
  expect(call).toBe(2);
  expect(outcome.result.execution.status).toBe("failed");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(outcome.result.exitCode).toBe(2);
  expect(defined(outcome.result.cases[0]).trials).toHaveLength(2);
  expect(
    existsSync(
      defined(defined(defined(defined(outcome.result.cases[0])).trials[0]))
        .artifactPath,
    ),
  ).toBe(true);
  const failedEvidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expect(
    defined(failedEvidence.trials[1]).candidateDurationMs,
  ).toBeGreaterThanOrEqual(0);
  expect(await readFile(outcome.result.evidencePath, "utf8")).not.toContain(
    "private host failure",
  );
});
test("engine refuses an equivalent live run before a second host starts", async () => {
  const paths = await rootsForRun();
  let releaseHost: (() => void) | undefined;
  let hostStarted: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseHost = resolve;
  });
  const started = new Promise<void>((resolve) => {
    hostStarted = resolve;
  });
  let calls = 0;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run() {
      calls++;
      hostStarted?.();
      await gate;
      return { finalMessage: "ready", complete: true };
    },
  };
  const options = {
    ...paths,
    case: baseCase,
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const first = runEvaluation(options);
  try {
    await Promise.race([
      started,
      Bun.sleep(5000).then(() => {
        throw new Error("first host did not start");
      }),
    ]);
    expect(runEvaluation(options)).rejects.toThrow(
      /equivalent Sevro run is active/,
    );
    expect(calls).toBe(1);
  } finally {
    releaseHost?.();
  }
  expect((await first).result.exitCode).toBe(0);
});
test("cancellation retains prior trial evidence and finalizes interruption", async () => {
  const paths = await rootsForRun();
  const controller = new AbortController();
  let waiting: (() => void) | undefined;
  const secondStarted = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  let calls = 0;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run({ signal }) {
      calls++;
      if (calls === 1) return { finalMessage: "ready", complete: true };
      waiting?.();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
    },
  };
  const running = runEvaluation({
    ...paths,
    case: baseCase,
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 2,
    passThreshold: 1,
    jobs: 1,
    signal: controller.signal,
  });
  await Promise.race([
    secondStarted,
    Bun.sleep(5000).then(() => {
      throw new Error("second trial did not start");
    }),
  ]);
  controller.abort("SIGTERM");
  const outcome = await running;
  expect(outcome.result.exitCode).toBe(143);
  expect(outcome.result.execution.status).toBe("cancelled");
  expect(defined(outcome.result.cases[0]).trials).toHaveLength(2);
  expect(defined(defined(outcome.result.cases[0]).trials[0]).task.verdict).toBe(
    "passed",
  );
  const active = parseCheckpoint(
    await readFile(
      join(paths.resultsRoot, "active", `${outcome.result.runId}.json`),
      "utf8",
    ),
  );
  expect(active.status).toBe("interrupted");
  expect(active.completedTrials).toHaveLength(2);
  expect(
    existsSync(
      defined(defined(defined(defined(outcome.result.cases[0])).trials[0]))
        .artifactPath,
    ),
  ).toBeTrue();
});
test("stores checkpoints apart from results and hides run state from shell checks", async () => {
  if (!isolatedNativeHost) return;
  const paths = await rootsForRun();
  const runStateRoot = await mkdtemp(join(tmpdir(), "sevro-state-test-"));
  roots.push(runStateRoot);
  const secret = join(runStateRoot, "private-state.txt");
  await writeFile(secret, "hidden run state\n");
  const outcome = await runEvaluation({
    ...paths,
    runStateRoot,
    case: {
      ...baseCase,
      checks: [
        ...baseCase.checks,
        {
          id: "state-hidden",
          grader: "sevro.shell",
          configuration: {
            run: `if cat '${secret}' >/dev/null 2>&1; then exit 1; fi`,
          },
        },
      ],
    },
    host: {
      id: "sevro.host.synthetic",
      model: "synthetic-v1",
      effort: "none",
      run() {
        return Promise.resolve({ finalMessage: "ready", complete: true });
      },
    },
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.exitCode).toBe(0);
  expect(
    defined(defined(defined(outcome.result.cases[0]).trials[0]).checks[1])
      .status,
  ).toBe("passed");
  const activePath = join(
    runStateRoot,
    "active",
    `${outcome.result.runId}.json`,
  );
  const active = parseCheckpoint(await readFile(activePath, "utf8"));
  expect(active).toMatchObject({
    format: "sevro.active-run.v1",
    status: "complete",
    artifactPath: outcome.result.evidencePath,
    completedTrials: [
      {
        trial: 1,
        artifactPath: defined(
          defined(defined(defined(outcome.result.cases[0])).trials[0]),
        ).artifactPath,
      },
    ],
  });
  const checkpoint = parseCheckpoint(
    await readFile(defined(active.checkpointPath), "utf8"),
  );
  expect(checkpoint.format).toBe("sevro.run-checkpoint.v1");
  expectUnknown(checkpoint.completedTrials).toEqual(active.completedTrials);
  expect(existsSync(join(paths.resultsRoot, "active"))).toBeFalse();
  expect(await readFile(secret, "utf8")).toBe("hidden run state\n");
});
test("failed trial persistence retains its fixture and never returns success", async () => {
  const paths = await rootsForRun();
  let workspace = "";
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run(request) {
      workspace = request.workspace;
      const runId = (await readdir(paths.resultsRoot)).find((name) =>
        /^[a-f0-9]{8}-/.test(name),
      );
      await mkdir(join(paths.resultsRoot, defined(runId), "trial-1.json"));
      return { finalMessage: "ready", complete: true };
    },
  };
  try {
    expect(
      runEvaluation({
        ...paths,
        case: baseCase,
        host,
        runnerBuildDigest: digest,
        projectDigest: digest,
        condition: "passive",
        trialCount: 1,
        passThreshold: 1,
      }),
    ).rejects.toThrow(/trial persistence failed; fixture retained/);
    expect(existsSync(workspace)).toBe(true);
    const [activeName] = await readdir(join(paths.resultsRoot, "active"));
    const active = parseCheckpoint(
      await readFile(
        join(paths.resultsRoot, "active", defined(activeName)),
        "utf8",
      ),
    );
    expect(active.status).toBe("diagnostic");
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
});
test("rejects fixture paths that could escape their workspace", async () => {
  const paths = await rootsForRun();
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      return Promise.reject(new Error("must not run"));
    },
  };
  expect(
    runEvaluation({
      ...paths,
      case: { ...baseCase, fixture: { files: { "../outside": "unsafe" } } },
      host,
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    }),
  ).rejects.toThrow(/invalid fixture path/);
  expect(existsSync(join(paths.projectRoot, "outside"))).toBe(false);
  expect(
    runEvaluation({
      ...paths,
      case: { ...baseCase, requiredEvidence: ["invalid"] },
      host,
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    }),
  ).rejects.toThrow(/invalid required evidence IDs/);
  expect(
    runEvaluation({
      ...paths,
      case: { ...baseCase, fixture: { sourceRef: "" } },
      host,
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    }),
  ).rejects.toThrow(/invalid repository fixture/);
});
test("shell checks grade fixture effects and retain exit observations", async () => {
  if (!isolatedNativeHost) return;
  const paths = await rootsForRun();
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run({ workspace }) {
      await writeFile(join(workspace, "created.txt"), "done\n");
      return { finalMessage: "ready", complete: true };
    },
  };
  const outcome = await runEvaluation({
    ...paths,
    case: {
      ...baseCase,
      checks: [
        {
          id: "file-created",
          grader: "sevro.shell",
          configuration: {
            run: "cat created.txt",
            expectExact: "done",
            expectRegex: "^done$",
            notRegex: "missing",
          },
        },
        ...baseCase.checks,
      ],
    },
    host,
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.exitCode).toBe(0);
  expect(
    defined(defined(defined(outcome.result.cases[0]).trials[0]).checks[0]),
  ).toMatchObject({
    id: "file-created",
    status: "passed",
    evidenceRefs: ["sevro.observation.shell.file-created"],
  });
  expectUnknown(
    defined(defined(outcome.result.cases[0]).trials[0]).checks.map(
      (check) => check.id,
    ),
  ).toEqual(["file-created", "response"]);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expect(defined(defined(evidence.trials[0]).observations[1])).toMatchObject({
    id: "sevro.observation.shell.file-created",
    completeness: "complete",
    data: { exitCode: 0, expectedExitCode: 0 },
  });
  expect(
    defined(defined(evidence.trials[0]).observations[1]).data.stdoutSha256,
  ).toMatch(/^[a-f0-9]{64}$/);
  expect(
    defined(defined(evidence.trials[0]).observations[1]).data.stdoutByteLength,
  ).toBe(5);
  expect(
    evidence.graders.active.map((grader: { id: string }) => grader.id),
  ).toContain("sevro.shell");
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("shell failures and timeouts remain distinct from host completion", async () => {
  if (!isolatedNativeHost) return;
  const paths = await rootsForRun();
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  const options = {
    ...paths,
    host,
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const failed = await runEvaluation({
    ...options,
    case: {
      ...baseCase,
      checks: [
        {
          id: "missing-file",
          grader: "sevro.shell",
          configuration: { run: "test -f absent.txt" },
        },
      ],
    },
  });
  expect(failed.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "failed" },
    exitCode: 1,
  });
  const outputFailed = await runEvaluation({
    ...options,
    case: {
      ...baseCase,
      checks: [
        {
          id: "wrong-output",
          grader: "sevro.shell",
          configuration: { run: "printf 'actual\\n'", expectExact: "expected" },
        },
      ],
    },
  });
  expect(outputFailed.result.task.verdict).toBe("failed");
  expect(outputFailed.result.exitCode).toBe(1);
  const timedOut = await runEvaluation({
    ...options,
    case: {
      ...baseCase,
      checks: [
        {
          id: "slow",
          grader: "sevro.shell",
          configuration: { run: "sleep 10", timeoutMs: 50 },
        },
      ],
    },
  });
  expect(timedOut.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "error" },
    task: { verdict: "not_assessed" },
    exitCode: 3,
  });
  expect(
    runEvaluation({
      ...options,
      shellIsolation: undefined,
      case: {
        ...baseCase,
        checks: [
          {
            id: "shell",
            grader: "sevro.shell",
            configuration: { run: "true" },
          },
        ],
      },
    }),
  ).rejects.toThrow(/explicit protected source roots/);
});
test("engine retains a failed candidate workspace while preserving saved evidence", async () => {
  const paths = await rootsForRun();
  let workspace = "";
  const outcome = await runEvaluation({
    ...paths,
    case: baseCase,
    host: {
      id: "sevro.host.synthetic",
      model: "synthetic-v1",
      effort: "none",
      run(request) {
        workspace = request.workspace;
        return Promise.resolve({
          finalMessage: null,
          complete: false,
          executionFailed: true,
        });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  roots.push(workspace);
  expect(outcome.result.exitCode).toBe(2);
  expect(await Bun.file(outcome.result.evidencePath).exists()).toBe(true);
  expect(existsSync(workspace)).toBe(true);
  expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
    "fixture content\n",
  );
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const observation = defined(
    defined(evidence.trials[0]).observations.find(
      (item) => item.id === "sevro.observation.workspaces",
    ),
  );
  expectUnknown(observation.data).toMatchObject({ candidate: workspace });
});
test("engine retains the semantic workspace when grading fails", async () => {
  const paths = await rootsForRun();
  let workspace = "";
  const outcome = await runEvaluation({
    ...paths,
    case: {
      ...baseCase,
      checks: [
        {
          id: "ready",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
    },
    host: {
      id: "example.candidate",
      model: "synthetic",
      effort: "none",
      run() {
        return Promise.resolve({ finalMessage: "ready", complete: true });
      },
    },
    semanticHost: {
      id: "example.semantic",
      model: "synthetic",
      effort: "none",
      async run(request) {
        workspace = request.workspace;
        await writeFile(join(workspace, "failure-details"), "inspect me");
        throw new Error("controlled grader failure");
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  roots.push(workspace);
  expect(outcome.result.exitCode).toBe(3);
  expect(await Bun.file(join(workspace, "failure-details")).exists()).toBe(
    true,
  );
});
test("engine retains the candidate workspace when required grading evidence is unavailable", async () => {
  const paths = await rootsForRun();
  let workspace = "";
  const { result } = await runEvaluation({
    ...paths,
    case: { ...baseCase, requiredEvidence: ["example.required-trace"] },
    host: {
      id: "example.incomplete-evidence",
      model: "synthetic",
      effort: "none",
      run(request) {
        workspace = request.workspace;
        return Promise.resolve({ finalMessage: "ready", complete: true });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  roots.push(workspace);
  expect(result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "unavailable" },
    task: { verdict: "not_assessed" },
    exitCode: 4,
  });
  expect(await Bun.file(join(workspace, "README.md")).exists()).toBe(true);
  expect(await Bun.file(result.evidencePath).exists()).toBe(true);
});
test("engine startup expires inactive failed workspaces after a day without deleting evidence", async () => {
  if (
    await runRetentionInIsolation(
      "engine startup expires inactive failed workspaces after a day without deleting evidence",
    )
  )
    return;
  const paths = await rootsForRun();
  let workspace = "";
  const options = {
    ...paths,
    case: baseCase,
    host: {
      id: "sevro.host.synthetic",
      model: "synthetic-v1",
      effort: "none",
      run(request: Parameters<HostAdapter["run"]>[0]) {
        workspace = request.workspace;
        return Promise.resolve({
          finalMessage: null,
          complete: false,
          executionFailed: true,
        });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const first = await runEvaluation(options);
    const retained = workspace;
    roots.push(retained);
    const evidence = await readFile(first.result.evidencePath, "utf8");
    clock.mockReturnValue(now + 24 * 60 * 60_000 - 1);
    await runEvaluation(options);
    roots.push(workspace);
    expect(existsSync(retained)).toBe(true);
    clock.mockReturnValue(now + 24 * 60 * 60_000 + 1);
    await runEvaluation(options);
    roots.push(workspace);
    expect(existsSync(retained)).toBe(false);
    expect(await readFile(first.result.evidencePath, "utf8")).toBe(evidence);
  } finally {
    clock.mockRestore();
  }
});
test("engine startup preserves an active workspace older than a day", async () => {
  if (
    await runRetentionInIsolation(
      "engine startup preserves an active workspace older than a day",
    )
  )
    return;
  const paths = await rootsForRun();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let workspace = "";
  const options = {
    ...paths,
    case: baseCase,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const active = runEvaluation({
    ...options,
    host: {
      id: "example.active",
      model: "synthetic",
      effort: "none",
      async run(request) {
        workspace = request.workspace;
        entered.resolve(undefined);
        await release.promise;
        return { finalMessage: "ready", complete: true };
      },
    },
  });
  await entered.promise;
  const clock = spyOn(Date, "now").mockReturnValue(
    Date.now() + 24 * 60 * 60_000 + 1,
  );
  try {
    await runEvaluation({
      ...options,
      host: {
        id: "example.peer",
        model: "synthetic",
        effort: "none",
        run() {
          return Promise.resolve({ finalMessage: "ready", complete: true });
        },
      },
    });
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "fixture content\n",
    );
  } finally {
    release.resolve(undefined);
    await active;
    clock.mockRestore();
  }
});
test("engine startup removes expired ownership records after a workspace was deleted manually", async () => {
  if (
    await runRetentionInIsolation(
      "engine startup removes expired ownership records after a workspace was deleted manually",
    )
  )
    return;
  const paths = await rootsForRun();
  let workspace = "";
  const options = {
    ...paths,
    case: baseCase,
    host: {
      id: "example.failure",
      model: "synthetic",
      effort: "none",
      run(request: Parameters<HostAdapter["run"]>[0]) {
        workspace = request.workspace;
        return Promise.resolve({
          finalMessage: null,
          complete: false,
          executionFailed: true,
        });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  await runEvaluation(options);
  const recordPath = join(
    dirname(workspace),
    ".owners",
    `${basename(workspace)}.json`,
  );
  const record = parseRecord(await readFile(recordPath, "utf8"));
  await writeFile(
    recordPath,
    JSON.stringify({
      ...record,
      timestamp: Date.now() - 24 * 60 * 60_000 - 1000,
    }),
    { mode: 0o600 },
  );
  await rm(workspace, { recursive: true });
  await runEvaluation(options);
  roots.push(workspace);
  expect(await Bun.file(recordPath).exists()).toBe(false);
});
test("engine startup preserves a workspace with unreadable ownership metadata", async () => {
  const name =
    "engine startup preserves a workspace with unreadable ownership metadata";
  if (await runRetentionInIsolation(name)) return;
  const paths = await rootsForRun();
  let workspace = "";
  const options = {
    ...paths,
    case: baseCase,
    host: {
      id: "example.failure",
      model: "synthetic",
      effort: "none",
      run(request: Parameters<HostAdapter["run"]>[0]) {
        workspace = request.workspace;
        return Promise.resolve({
          finalMessage: null,
          complete: false,
          executionFailed: true,
        });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const first = await runEvaluation(options);
  const retained = workspace;
  roots.push(retained);
  const evidence = await readFile(first.result.evidencePath, "utf8");
  const metadata = join(
    dirname(retained),
    ".owners",
    `${basename(retained)}.json`,
  );
  await chmod(metadata, 0);
  const clock = spyOn(Date, "now").mockReturnValue(
    Date.now() + 24 * 60 * 60_000 + 1000,
  );
  try {
    const next = await runEvaluation(options);
    roots.push(workspace);
    expect(next.result.exitCode).toBe(2);
    expect(await readFile(join(retained, "README.md"), "utf8")).toBe(
      "fixture content\n",
    );
    expect(await readFile(first.result.evidencePath, "utf8")).toBe(evidence);
  } finally {
    clock.mockRestore();
    await chmod(metadata, 0o600);
  }
});
test("engine startup preserves expired workspaces with unverifiable ownership", async () => {
  const name =
    "engine startup preserves expired workspaces with unverifiable ownership";
  if (await runRetentionInIsolation(name)) return;
  const paths = await rootsForRun();
  let workspace = "";
  const options = failedRetentionOptions(paths, (path) => {
    workspace = path;
  });
  const first = await runEvaluation(options);
  const retained = workspace;
  roots.push(retained);
  const metadata = join(
    dirname(retained),
    ".owners",
    `${basename(retained)}.json`,
  );
  const original = parseRecord(await readFile(metadata, "utf8"));
  const expired = {
    ...original,
    timestamp: Date.now() - 24 * 60 * 60_000 - 1000,
  };
  const evidence = await readFile(first.result.evidencePath, "utf8");
  const invalidRecords = [
    "{broken",
    "null",
    JSON.stringify({ ...expired, format: "unrecognized" }),
    JSON.stringify({ ...expired, state: "unrecognized" }),
    JSON.stringify({ ...expired, timestamp: "yesterday" }),
    JSON.stringify({ ...expired, timestamp: null }),
    JSON.stringify({ ...expired, owner: null }),
    JSON.stringify({
      ...expired,
      owner: { pid: 0, startedAt: "unknown", host: "unknown" },
    }),
    JSON.stringify({
      ...expired,
      owner: {
        ...parseRecord(JSON.stringify(original.owner)),
        host: "unrecognized",
      },
    }),
    " ".repeat(4097),
  ];
  for (const bytes of invalidRecords) {
    await writeFile(metadata, bytes, { mode: 0o600 });
    await runEvaluation(options);
    roots.push(workspace);
    expect(
      await readFile(join(retained, "README.md"), "utf8"),
      bytes.slice(0, 200),
    ).toBe("fixture content\n");
  }
  await writeFile(metadata, JSON.stringify(expired));
  await chmod(metadata, 0o644);
  await runEvaluation(options);
  roots.push(workspace);
  expect(await readFile(join(retained, "README.md"), "utf8")).toBe(
    "fixture content\n",
  );
  await rm(metadata);
  await runEvaluation(options);
  roots.push(workspace);
  expect(await readFile(join(retained, "README.md"), "utf8")).toBe(
    "fixture content\n",
  );
  const external = join(paths.projectRoot, "external-owner.json");
  await writeFile(external, JSON.stringify(expired));
  await symlink(external, metadata);
  await runEvaluation(options);
  roots.push(workspace);
  expect(await readFile(join(retained, "README.md"), "utf8")).toBe(
    "fixture content\n",
  );
  expect(await readFile(external, "utf8")).toBe(JSON.stringify(expired));
  expect(await readFile(first.result.evidencePath, "utf8")).toBe(evidence);
});
test("engine startup cleanup tolerates concurrent evaluations expiring the same workspace", async () => {
  const name =
    "engine startup cleanup tolerates concurrent evaluations expiring the same workspace";
  if (await runRetentionInIsolation(name)) return;
  const paths = await rootsForRun();
  let workspace = "";
  const options = failedRetentionOptions(paths, (path) => {
    workspace = path;
    roots.push(path);
  });
  for (let round = 0; round < 10; round++) {
    await runEvaluation(options);
    const retained = workspace;
    const metadata = join(
      dirname(retained),
      ".owners",
      `${basename(retained)}.json`,
    );
    const original = parseRecord(await readFile(metadata, "utf8"));
    await writeFile(
      metadata,
      JSON.stringify({
        ...original,
        timestamp: Date.now() - 24 * 60 * 60_000 - 1000,
      }),
    );
    const outcomes = await Promise.all(
      [0, 1, 2, 3].map((peer) =>
        runEvaluation({
          ...options,
          case: { ...baseCase, id: `concurrent-cleanup-${round}-${peer}` },
        }),
      ),
    );
    expect(outcomes.map((outcome) => outcome.result.exitCode)).toEqual([
      2, 2, 2, 2,
    ]);
    expect(existsSync(retained)).toBe(false);
  }
});
test("engine shell isolation hides a sibling created after sandbox launch", async () => {
  if (!isolatedNativeHost) return;
  const paths = await rootsForRun();
  const control = await mkdtemp(join(tmpdir(), "sevro-isolation-control-"));
  roots.push(control);
  const marker = join(control, "started");
  const published = join(control, "published");
  let prepared: Promise<void> = Promise.resolve();
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run({ workspace }) {
      prepared = (async () => {
        await waitForIsolationMarker(marker);
        const peer = join(
          dirname(workspace),
          `sevro-case-future-${basename(workspace)}`,
        );
        await mkdir(peer, { mode: 0o700 });
        roots.push(peer);
        await writeFile(join(peer, "secret"), "original");
        await writeFile(published, peer);
      })();
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  const outcome = await runEvaluation({
    ...paths,
    case: {
      ...baseCase,
      checks: [
        {
          id: "isolated",
          grader: "sevro.shell",
          configuration: {
            run: `touch '${marker}'
while ! test -f '${published}'; do sleep 0.01; done
peer=$(cat '${published}')
cat README.md >/dev/null
printf own > own-file
if cat "$peer/secret" >/dev/null 2>&1; then exit 1; fi
if (printf changed > "$peer/secret") 2>/dev/null; then exit 1; fi
if ls ../.owners >/dev/null 2>&1; then exit 1; fi
printf isolated`,
            expectExact: "isolated",
            timeoutMs: 10000,
          },
        },
      ],
    },
    host,
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  await prepared;
  expect(outcome.result.exitCode).toBe(0);
  expect(outcome.result.task.verdict).toBe("passed");
});
test("engine shell isolation hides project sources and explicitly protected peer fixtures", async () => {
  if (!isolatedNativeHost) return;
  const paths = await rootsForRun();
  const peer = await mkdtemp(join(tmpdir(), "sevro-case-peer-"));
  roots.push(peer);
  const projectSecret = join(paths.projectRoot, "source-secret.txt");
  const peerSecret = join(peer, "peer-secret.txt");
  await writeFile(projectSecret, "source\n");
  await writeFile(peerSecret, "peer\n");
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  const outcome = await runEvaluation({
    ...paths,
    case: {
      ...baseCase,
      checks: [projectSecret, peerSecret].map((path, index) => ({
        id: `hidden-${index}`,
        grader: "sevro.shell",
        configuration: {
          run: `/bin/cat '${path}' >/dev/null`,
          expectedExitCode: 1,
        },
      })),
    },
    host,
    shellIsolation: { protectedRoots: [peer] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.exitCode).toBe(0);
  expectUnknown(
    defined(defined(outcome.result.cases[0]).trials[0]).checks.map(
      (check) => check.status,
    ),
  ).toEqual(["passed", "passed"]);
});
