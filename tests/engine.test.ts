import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  expect(evidence.trials[0].usage).toEqual({
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    complete: false,
  });
  expect(evidence.result).toEqual(outcome.result);
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

test("failed trial persistence retains its fixture and never returns success", async () => {
  const paths = await rootsForRun();
  let workspace = "";
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run(request) {
      workspace = request.workspace;
      const [runId] = await readdir(paths.resultsRoot);
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
      case: { ...baseCase, requiredEvidence: ["sevro.host.trace"] },
      host,
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    }),
  ).rejects.toThrow(/required host evidence/);
});
