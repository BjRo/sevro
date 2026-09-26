import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluation, type HostAdapter } from "../src/engine";

const roots: string[] = [];
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
    projectDigest: digest,
    condition: "passive",
    trialCount: 2,
    passThreshold: 0.5,
  });
  expect(outcome.result).toMatchObject({
    format: "sevro.cli-result.v1",
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "passed" },
    exitCode: 0,
  });
  expect(
    outcome.result.cases[0]?.trials.map((trial) => trial.task.verdict),
  ).toEqual(["passed", "failed"]);
  for (const workspace of workspaces) expect(existsSync(workspace)).toBe(false);
  for (const trial of outcome.result.cases[0]!.trials)
    expect(existsSync(trial.artifactPath!)).toBe(true);
  const evidence = JSON.parse(
    await readFile(outcome.result.evidencePath!, "utf8"),
  );
  expect(evidence.format).toBe("sevro.run-evidence.v1");
  expect(evidence.trials).toHaveLength(2);
  expect(evidence.evaluationIdentity.dimensions.condition).toBe("passive");
  expect(evidence.runner).toMatchObject({
    source: "checkout",
    buildDigest: digest,
  });
  expect(evidence.runner.root).toMatch(/^file:\/\//);
  expect(evidence.runner.revision).toMatch(/^[a-f0-9]{40,64}$/);
  expect(
    evidence.runner.dirtyPatchDigest === null ||
      /^[a-f0-9]{64}$/.test(evidence.runner.dirtyPatchDigest),
  ).toBeTrue();
  expect(evidence.trials[0].usage).toEqual({
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    complete: false,
  });
  expect(evidence.result).toEqual(outcome.result);
});

test("dry preparation records every trial without executing the host", async () => {
  const paths = await rootsForRun();
  let hostCalls = 0;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run() {
      hostCalls++;
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
  expect(dry.result.cases[0]?.trials).toHaveLength(2);
  const dryEvidence = JSON.parse(
    await readFile(dry.result.evidencePath, "utf8"),
  );
  expect(
    dryEvidence.trials.map(
      (trial: { executionMode: string }) => trial.executionMode,
    ),
  ).toEqual(["dry", "dry"]);
  expect(dryEvidence.trials[0].rawResult.path).toBeNull();

  const executed = await runEvaluation(options);
  expect(hostCalls).toBe(2);
  const executedEvidence = JSON.parse(
    await readFile(executed.result.evidencePath, "utf8"),
  );
  expect(dryEvidence.evaluationIdentity.digest).not.toBe(
    executedEvidence.evaluationIdentity.digest,
  );
});

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
    async run() {
      return {
        finalMessage: "ready",
        complete: true,
        observations: [
          {
            id: "darrow.activation",
            completeness: "complete" as const,
            data: { selected: "darrow.tdd" },
          },
        ],
      };
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
  const evidence = JSON.parse(
    await readFile(passed.result.evidencePath, "utf8"),
  );
  expect(evidence.trials[0].observations[1]).toMatchObject({
    id: "darrow.activation",
    source: host.id,
    completeness: "complete",
  });

  const missing = await runEvaluation({
    ...options,
    host: {
      ...host,
      async run() {
        return { finalMessage: "ready", complete: true };
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
      async run() {
        return {
          finalMessage: "ready",
          complete: true,
          observations: [
            {
              id: "darrow.activation",
              completeness: "partial" as const,
              data: {},
            },
          ],
        };
      },
    },
  });
  expect(partial.result.exitCode).toBe(4);

  const invalid = await runEvaluation({
    ...options,
    host: {
      ...host,
      async run() {
        return {
          finalMessage: "ready",
          complete: true,
          observations: [
            {
              id: "sevro.observation.final-message",
              completeness: "complete" as const,
              data: {},
            },
          ],
        };
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
    async run() {
      call++;
      return {
        finalMessage: "ready",
        complete: true,
        artifacts: [
          {
            id: "example.host.trace",
            bytes: Buffer.from(`trace ${call}\n`),
          },
        ],
      };
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
    passThreshold: 1,
  };
  const outcome = await runEvaluation(options);
  expect(outcome.result.task.verdict).toBe("passed");
  const evidence = JSON.parse(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const refs = evidence.trials.map(
    (trial: { artifactRefs: { id: string; path: string }[] }) =>
      trial.artifactRefs.find((item) => item.id === "example.host.trace"),
  );
  expect(refs[0]?.path).not.toBe(refs[1]?.path);
  expect(await readFile(new URL(refs[0].path), "utf8")).toBe("trace 1\n");
  expect(await readFile(new URL(refs[1].path), "utf8")).toBe("trace 2\n");

  const missing = await runEvaluation({
    ...options,
    host: {
      ...host,
      async run() {
        return { finalMessage: "ready", complete: true };
      },
    },
  });
  expect(missing.result.grading.status).toBe("unavailable");
  expect(missing.result.exitCode).toBe(4);

  const invalid = await runEvaluation({
    ...options,
    host: {
      ...host,
      async run() {
        return {
          finalMessage: "ready",
          complete: true,
          artifacts: [{ id: "../outside", bytes: Buffer.from("bad") }],
        };
      },
    },
  });
  expect(invalid.result.execution.status).toBe("failed");
  expect(invalid.result.task.verdict).toBe("not_assessed");
});

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
    async run() {
      return { finalMessage: "ready", complete: true };
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
  const evidence = JSON.parse(
    await readFile(passed.result.evidencePath, "utf8"),
  );
  expect(evidence.routes.map((route: { role: string }) => route.role)).toEqual([
    "candidate",
    "semantic",
  ]);
  expect(evidence.trials[0].observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: semanticHost.id,
        data: { verdict: "pass", reason: "Ready is stated" },
      }),
    ]),
  );
  const artifacts = evidence.trials[0].artifactRefs;
  const raw = artifacts.find(
    (item: { id: string }) => item.id === "sevro.semantic.verdicts",
  );
  const trace = artifacts.find(
    (item: { id: string }) => item.id === "sevro.semantic.example.trace",
  );
  expect(await readFile(new URL(raw.path), "utf8")).toContain('"id":"promise"');
  expect(await readFile(new URL(trace.path), "utf8")).toBe("grader trace\n");

  await expect(
    runEvaluation({ ...options, semanticHost: undefined }),
  ).rejects.toThrow(/explicit semantic host/);
  const incomplete = await runEvaluation({
    ...options,
    host: {
      ...host,
      async run() {
        return { finalMessage: null, complete: false };
      },
    },
  });
  expect(semanticCalls).toBe(1);
  expect(incomplete.result.grading.status).toBe("unavailable");
  expect(incomplete.result.cases[0]?.trials[0]?.checks[0]?.status).toBe(
    "unavailable",
  );
  const malformed = await runEvaluation({
    ...options,
    semanticHost: {
      ...semanticHost,
      async run() {
        return { finalMessage: "invalid", complete: true };
      },
    },
  });
  expect(malformed.result.grading.status).toBe("error");
  expect(malformed.result.exitCode).toBe(3);
  const failed = await runEvaluation({
    ...options,
    semanticHost: {
      ...semanticHost,
      async run() {
        return {
          finalMessage:
            '{"checks":[{"id":"promise","verdict":"fail","reason":"No promise"}]}',
          complete: true,
        };
      },
    },
  });
  expect(failed.result.task.verdict).toBe("failed");
});

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
  const evidence = JSON.parse(
    await readFile(passed.result.evidencePath, "utf8"),
  );
  expect(evidence.routes.map((route: { role: string }) => route.role)).toEqual([
    "candidate",
    "advisory",
  ]);
  expect(evidence.trials[0].advisoryReview).toMatchObject({
    status: "completed",
    assessment: { verdict: "fail", overallScore: 2 },
    usage: { inputTokens: 40, outputTokens: 20, complete: true },
  });
  const raw = evidence.trials[0].advisoryReview.rawResult;
  expect(await readFile(new URL(raw.path), "utf8")).toContain(
    '"verdict":"fail"',
  );
  const trace = evidence.trials[0].artifactRefs.find(
    (item: { id: string }) => item.id === "sevro.advisory.review.trace",
  );
  expect(await readFile(new URL(trace.path), "utf8")).toBe("review trace\n");

  const malformed = await runEvaluation({
    ...options,
    advisoryHost: {
      ...advisoryHost,
      async run() {
        return { finalMessage: "invalid", complete: true };
      },
    },
  });
  expect(malformed.result.task.verdict).toBe("passed");
  const failedEvidence = JSON.parse(
    await readFile(malformed.result.evidencePath, "utf8"),
  );
  expect(failedEvidence.trials[0].advisoryReview.status).toBe("failed");
  expect(failedEvidence.trials[0].advisoryReview.assessment).toBeNull();

  const rejected = await runEvaluation({
    ...options,
    advisoryHost: {
      ...advisoryHost,
      async run() {
        throw new Error("private reviewer failure");
      },
    },
  });
  expect(rejected.result.task.verdict).toBe("passed");
  const rejectedEvidence = JSON.parse(
    await readFile(rejected.result.evidencePath, "utf8"),
  );
  expect(rejectedEvidence.trials[0].advisoryReview.status).toBe("failed");

  const dry = await runEvaluation({ ...options, dry: true });
  const dryEvidence = JSON.parse(
    await readFile(dry.result.evidencePath, "utf8"),
  );
  expect(dryEvidence.trials[0].advisoryReview.status).toBe("not_run");
  expect(reviewCalls).toBe(1);

  await expect(runEvaluation({ ...options, case: baseCase })).rejects.toThrow(
    /Git fixture/,
  );
  await expect(
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
    async run() {
      call++;
      if (call === 2) throw new Error("private host failure");
      return { finalMessage: "ready", complete: true };
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
    passThreshold: 0.5,
  });
  expect(call).toBe(2);
  expect(outcome.result.execution.status).toBe("failed");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(outcome.result.exitCode).toBe(2);
  expect(outcome.result.cases[0]?.trials).toHaveLength(2);
  expect(existsSync(outcome.result.cases[0]!.trials[0]!.artifactPath!)).toBe(
    true,
  );
  expect(await readFile(outcome.result.evidencePath!, "utf8")).not.toContain(
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
    await expect(runEvaluation(options)).rejects.toThrow(
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
          () => reject(new Error("cancelled")),
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
  expect(outcome.result.cases[0]?.trials).toHaveLength(2);
  expect(outcome.result.cases[0]?.trials[0]?.task.verdict).toBe("passed");
  const active = JSON.parse(
    await readFile(
      join(paths.resultsRoot, "active", `${outcome.result.runId}.json`),
      "utf8",
    ),
  );
  expect(active.status).toBe("interrupted");
  expect(active.completedTrials).toHaveLength(2);
  expect(
    existsSync(outcome.result.cases[0]!.trials[0]!.artifactPath),
  ).toBeTrue();
});

test("stores checkpoints apart from results and hides run state from shell checks", async () => {
  if (process.platform !== "darwin") return;
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
      async run() {
        return { finalMessage: "ready", complete: true };
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
  expect(outcome.result.cases[0]?.trials[0]?.checks[1]?.status).toBe("passed");
  const activePath = join(
    runStateRoot,
    "active",
    `${outcome.result.runId}.json`,
  );
  const active = JSON.parse(await readFile(activePath, "utf8"));
  expect(active).toMatchObject({
    format: "sevro.active-run.v1",
    status: "complete",
    artifactPath: outcome.result.evidencePath,
    completedTrials: [
      {
        trial: 1,
        artifactPath: outcome.result.cases[0]!.trials[0]!.artifactPath,
      },
    ],
  });
  const checkpoint = JSON.parse(await readFile(active.checkpointPath, "utf8"));
  expect(checkpoint.format).toBe("sevro.run-checkpoint.v1");
  expect(checkpoint.completedTrials).toEqual(active.completedTrials);
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
      await mkdir(join(paths.resultsRoot, runId!, "trial-1.json"));
      return { finalMessage: "ready", complete: true };
    },
  };
  try {
    await expect(
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
    const active = JSON.parse(
      await readFile(join(paths.resultsRoot, "active", activeName!), "utf8"),
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
    async run() {
      throw new Error("must not run");
    },
  };
  await expect(
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
  await expect(
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
  await expect(
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
  ).rejects.toThrow(/fixture must declare/);
});

test("shell checks grade fixture effects and retain exit observations", async () => {
  if (process.platform !== "darwin") return;
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
  expect(outcome.result.cases[0]?.trials[0]?.checks[0]).toMatchObject({
    id: "file-created",
    status: "passed",
    evidenceRefs: ["sevro.observation.shell.file-created"],
  });
  expect(
    outcome.result.cases[0]?.trials[0]?.checks.map((check) => check.id),
  ).toEqual(["file-created", "response"]);
  const evidence = JSON.parse(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expect(evidence.trials[0].observations[1]).toMatchObject({
    id: "sevro.observation.shell.file-created",
    completeness: "complete",
    data: { exitCode: 0, expectedExitCode: 0 },
  });
  expect(evidence.trials[0].observations[1].data.stdoutSha256).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(evidence.trials[0].observations[1].data.stdoutByteLength).toBe(5);
  expect(
    evidence.graders.active.map((grader: { id: string }) => grader.id),
  ).toContain("sevro.shell");
});

test("shell failures and timeouts remain distinct from host completion", async () => {
  if (process.platform !== "darwin") return;
  const paths = await rootsForRun();
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run() {
      return { finalMessage: "ready", complete: true };
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
  await expect(
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

test("engine shell isolation hides project sources and peer fixtures", async () => {
  if (process.platform !== "darwin") return;
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
    async run() {
      return { finalMessage: "ready", complete: true };
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
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.exitCode).toBe(0);
  expect(
    outcome.result.cases[0]?.trials[0]?.checks.map((check) => check.status),
  ).toEqual(["passed", "passed"]);
});
