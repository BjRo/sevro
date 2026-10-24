import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluation, type HostAdapter } from "../../src/engine";
import {
  defined,
  expectUnknown,
  parseCheckpoint,
  parseRunEvidence,
} from "../fixtures/assertions";
import {
  baseCase,
  digest,
  isolatedNativeHost,
  rootsForRun,
} from "../fixtures/engine";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("host failure retains completed trials and reports execution failure", async () => {
  const paths = await rootsForRun(roots);
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
  const paths = await rootsForRun(roots);
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
  const paths = await rootsForRun(roots);
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
  const paths = await rootsForRun(roots);
  const runStateRoot = await temporaryFixture(
    join(tmpdir(), "sevro-state-test-"),
  );

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
  const paths = await rootsForRun(roots);
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
  const paths = await rootsForRun(roots);
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
  const paths = await rootsForRun(roots);
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
  const paths = await rootsForRun(roots);
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
