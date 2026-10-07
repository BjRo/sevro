import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openExtensionSession } from "../src/extension-session";
import { wireOptions } from "./fixtures/quality-engine-session";
import {
  runEvaluation,
  EvaluationConfigurationError,
  type EvaluationOptions,
  type HostResult,
} from "../src/engine";
import { defined, parseRecord, parseRunEvidence } from "./fixtures/assertions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function evaluation(result: HostResult): Promise<EvaluationOptions> {
  const root = await mkdtemp(join(tmpdir(), "sevro-engine-quality-"));
  roots.push(root);
  return {
    projectRoot: root,
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    case: {
      id: "ready",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "independent fixture\n" } },
      checks: [
        {
          id: "response",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    },
    host: {
      id: "example.host",
      model: "fixture-v1",
      effort: "none",
      run: () => Promise.resolve(result),
    },
  };
}

function observation(id: string) {
  return { id, completeness: "complete" as const, data: { ready: true } };
}

function requireSemantic(options: EvaluationOptions, result: HostResult): void {
  options.case.checks = [
    {
      id: "meaning",
      grader: "sevro.semantic",
      configuration: { proposition: "The response confirms readiness." },
    },
  ];
  options.semanticHost = {
    id: "example.semantic-host",
    model: "grader-v1",
    effort: "none",
    run: () => Promise.resolve(result),
  };
}

function advisoryResponse(): string {
  return JSON.stringify({
    verdict: "pass",
    overallScore: 5,
    dimensions: {
      correctness: 5,
      maintainability: 5,
      testQuality: 5,
      scopeDiscipline: 5,
    },
    strengths: ["clear"],
    weaknesses: [],
    summary: "A passing independent review.",
  });
}

async function extensionEvaluation(
  responses: Record<string, unknown> = {},
): Promise<EvaluationOptions> {
  const options = await evaluation({
    finalMessage: "ready",
    complete: true,
    observations: [observation("example.evidence")],
  });
  const session = await openExtensionSession(wireOptions(responses));
  const resolved = defined(
    (await session.resolve(pathToFileURL(options.projectRoot).href, {}))[0],
  );
  if (resolved.fixture.kind !== "inline")
    throw new Error("Expected inline wire fixture");
  options.case = { ...resolved, fixture: { files: resolved.fixture.files } };
  options.extension = { session, resolvedCase: resolved };
  return options;
}

test("refuses a selected case that diverges from the extension-resolved declaration", async () => {
  const options = await extensionEvaluation();
  expect((await runEvaluation(options)).result.task.verdict).toBe("passed");
  options.case = { ...options.case, prompt: "Different selected task." };
  expect(runEvaluation(options)).rejects.toThrow(
    "resolved extension case does not match the selected case",
  );
});

const preparationRefusals = [
  {
    name: "Git-excluded artifact for an inline fixture",
    prepared: {
      artifacts: [
        {
          id: "example.file",
          relativePath: "prepared.txt",
          contentBase64: Buffer.from("prepared").toString("base64"),
          sha256: createHash("sha256").update("prepared").digest("hex"),
          gitExclude: true,
        },
      ],
    },
    diagnostic: "Git-excluded preparation artifacts require a Git fixture",
  },
  {
    name: "artifact that collides with fixture content",
    prepared: {
      artifacts: [
        {
          id: "example.file",
          relativePath: "README.md",
          contentBase64: Buffer.from("prepared").toString("base64"),
          sha256: createHash("sha256").update("prepared").digest("hex"),
        },
      ],
    },
    diagnostic: "collide",
  },
];

for (const refusal of preparationRefusals) {
  test(`refuses ${refusal.name} before admitting a candidate`, async () => {
    const options = await extensionEvaluation({
      prepare: {
        requestedInstrumentation: [],
        extensionData: {},
        ...refusal.prepared,
      },
    });
    let calls = 0;
    options.host.run = () => {
      calls++;
      return Promise.resolve({ finalMessage: "ready", complete: true });
    };
    const pending = runEvaluation(options);
    expect(pending).rejects.toBeInstanceOf(EvaluationConfigurationError);
    expect(pending).rejects.toThrow(refusal.diagnostic);
    await pending.catch(() => undefined);
    expect(calls).toBe(0);
    expect(existsSync(options.resultsRoot)).toBe(false);
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

test("records a failed advisory host without accepting its passing assessment", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  options.case.fixture = {
    kind: "generated",
    commits: [{ message: "base", files: { "README.md": "base\n" } }],
  };
  const message = advisoryResponse();
  let workspace = "";
  options.advisoryHost = {
    id: "example.advisory",
    model: "review-v1",
    effort: "none",
    run(request) {
      workspace = request.workspace;
      return Promise.resolve({
        finalMessage: message,
        complete: true,
        executionFailed: true,
        artifacts: [
          { id: "example.trace", bytes: Buffer.from("failed review trace") },
        ],
      });
    },
  };
  const outcome = await runEvaluation(options);
  expect(outcome.result.task.verdict).toBe("passed");
  expect(outcome.result.exitCode).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  const review = defined(trial.advisoryReview);
  expect(review.status).toBe("failed");
  expect(review.assessment).toBeNull();
  expect(await readFile(new URL(defined(review.rawResult.path)), "utf8")).toBe(
    message,
  );
  const trace = defined(
    trial.artifactRefs.find(
      (item) => item.id === "sevro.advisory.example.trace",
    ),
  );
  expect(await readFile(new URL(trace.path), "utf8")).toBe(
    "failed review trace",
  );
  expect(workspace).not.toBe("");
  expect(existsSync(workspace)).toBe(false);
});

const invalidPlans: {
  name: string;
  change: (options: EvaluationOptions) => void;
  diagnostic: string;
}[] = [
  {
    name: "unreadable project root",
    change(options) {
      options.projectRoot = join(options.projectRoot, "missing");
    },
    diagnostic: "project root is unreadable",
  },
  {
    name: "unsupported host continuation",
    change(options) {
      options.case.followUpPrompt = "Continue the task.";
    },
    diagnostic: "selected host does not support continuation",
  },
  {
    name: "generated history above the declared commit limit",
    change(options) {
      options.case.fixture = {
        kind: "generated",
        commits: Array.from({ length: 129 }, (_, index) => ({
          message: `commit ${index}`,
          files: {},
        })),
      };
    },
    diagnostic: "generated fixture",
  },
  {
    name: "generated repository metadata write",
    change(options) {
      options.case.fixture = {
        kind: "generated",
        commits: [{ message: "unsafe", files: { ".git/config": "unsafe" } }],
      };
    },
    diagnostic: "generated fixture cannot write repository metadata",
  },
  {
    name: "undeclared repository source",
    change(options) {
      options.case.fixture = { sourceRef: "undeclared" };
    },
    diagnostic: "repository source",
  },
  {
    name: "semantic check without a grader route",
    change(options) {
      requireSemantic(options, { finalMessage: "unused", complete: true });
      delete options.semanticHost;
    },
    diagnostic: "semantic checks require an explicit semantic host",
  },
  {
    name: "incomplete semantic host identity",
    change(options) {
      requireSemantic(options, { finalMessage: "unused", complete: true });
      defined(options.semanticHost).effort = "";
    },
    diagnostic: "semantic host identity is incomplete",
  },
  {
    name: "advisory review on an inline fixture",
    change(options) {
      options.advisoryHost = options.host;
    },
    diagnostic: "advisory review requires a Git fixture",
  },
  {
    name: "advisory exclusions without a reviewer",
    change(options) {
      options.advisoryExcludedPaths = ["README.md"];
    },
    diagnostic: "advisory exclusions require an advisory host",
  },
  {
    name: "duplicate check identities",
    change(options) {
      options.case.checks.push({ ...defined(options.case.checks[0]) });
    },
    diagnostic: "case check IDs must be unique",
  },
  {
    name: "unavailable extension grader",
    change(options) {
      defined(options.case.checks[0]).grader = "example.grader";
    },
    diagnostic: "case declares an unavailable extension grader",
  },
  {
    name: "shell check without isolation roots",
    change(options) {
      options.case.checks = [
        { id: "shell", grader: "sevro.shell", configuration: { run: "true" } },
      ];
    },
    diagnostic: "shell checks require explicit protected source roots",
  },
  {
    name: "Git HEAD check on an inline fixture",
    change(options) {
      options.case.checks = [
        {
          id: "revision",
          grader: "sevro.git-head",
          configuration: { mode: "unchanged" },
        },
      ];
    },
    diagnostic: "Git HEAD checks require a Git fixture",
  },
  {
    name: "relative project root",
    change: (options) => {
      options.projectRoot = "relative";
    },
    diagnostic: "roots must be absolute",
  },
  {
    name: "relative results root",
    change: (options) => {
      options.resultsRoot = "relative";
    },
    diagnostic: "roots must be absolute",
  },
  {
    name: "relative run-state root",
    change: (options) => {
      options.runStateRoot = "relative";
    },
    diagnostic: "roots must be absolute",
  },
  {
    name: "empty case identity",
    change: (options) => {
      options.case.id = "";
    },
    diagnostic: "identities must be nonempty",
  },
  {
    name: "empty host identity",
    change: (options) => {
      options.host.model = "";
    },
    diagnostic: "identities must be nonempty",
  },
  {
    name: "blank continuation",
    change: (options) => {
      options.case.followUpPrompt = " \n";
    },
    diagnostic: "follow-up prompt must be nonempty",
  },
  {
    name: "zero trials",
    change: (options) => {
      options.trialCount = 0;
    },
    diagnostic: "trial count must be a positive integer",
  },
  {
    name: "fractional trials",
    change: (options) => {
      options.trialCount = 1.5;
    },
    diagnostic: "trial count must be a positive integer",
  },
  {
    name: "zero concurrency",
    change: (options) => {
      options.jobs = 0;
    },
    diagnostic: "jobs must be a positive integer",
  },
  {
    name: "nonfinite threshold",
    change: (options) => {
      options.passThreshold = Number.POSITIVE_INFINITY;
    },
    diagnostic: "pass threshold must be greater than zero and at most one",
  },
  {
    name: "zero threshold",
    change: (options) => {
      options.passThreshold = 0;
    },
    diagnostic: "pass threshold must be greater than zero and at most one",
  },
  {
    name: "threshold above one",
    change: (options) => {
      options.passThreshold = 1.1;
    },
    diagnostic: "pass threshold must be greater than zero and at most one",
  },
  {
    name: "duplicate required evidence",
    change: (options) => {
      options.case.requiredEvidence = ["example.trace", "example.trace"];
    },
    diagnostic: "invalid required evidence IDs",
  },
  {
    name: "invalid required evidence",
    change: (options) => {
      options.case.requiredEvidence = ["../outside"];
    },
    diagnostic: "invalid required evidence IDs",
  },
];

for (const invalid of invalidPlans) {
  test(`refuses ${invalid.name} before candidate execution or result creation`, async () => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    const resultsRoot = options.resultsRoot;
    let calls = 0;
    options.host.run = () => {
      calls++;
      return Promise.resolve({ finalMessage: "ready", complete: true });
    };
    invalid.change(options);
    const pending = runEvaluation(options);
    expect(pending).rejects.toBeInstanceOf(EvaluationConfigurationError);
    expect(pending).rejects.toThrow(invalid.diagnostic);
    await pending.catch(() => undefined);
    expect(calls).toBe(0);
    expect(existsSync(resultsRoot)).toBe(false);
  });
}

const invalidReceipts: { name: string; result: HostResult }[] = [
  {
    name: "oversized final message",
    result: { finalMessage: "x".repeat(8 * 1024 * 1024 + 1), complete: true },
  },
  {
    name: "non-JSON observation data",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [
        {
          id: "example.trace",
          completeness: "complete",
          data: { value: Number.POSITIVE_INFINITY },
        },
      ],
    },
  },
  {
    name: "observation data beyond the byte limit",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [
        {
          id: "example.trace",
          completeness: "complete",
          data: { value: "x".repeat(8 * 1024 * 1024 + 1) },
        },
      ],
    },
  },
  {
    name: "artifact beyond the byte limit",
    result: {
      finalMessage: "ready",
      complete: true,
      artifacts: [
        { id: "example.trace", bytes: new Uint8Array(8 * 1024 * 1024 + 1) },
      ],
    },
  },
  {
    name: "artifact colliding with a built-in observation",
    result: {
      finalMessage: "ready",
      complete: true,
      artifacts: [
        {
          id: "sevro.observation.final-message",
          bytes: Buffer.from("collision"),
        },
      ],
    },
  },
  {
    name: "invalid observation ID",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [observation("../outside")],
    },
  },
  {
    name: "reserved observation ID",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [observation("sevro.observation.custom")],
    },
  },
  {
    name: "duplicate observations",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [
        observation("example.trace"),
        observation("example.trace"),
      ],
    },
  },
  {
    name: "observation count beyond the limit",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: Array.from({ length: 129 }, (_, index) =>
        observation(`example.trace-${index}`),
      ),
    },
  },
  {
    name: "duplicate artifacts",
    result: {
      finalMessage: "ready",
      complete: true,
      artifacts: [
        { id: "example.trace", bytes: Buffer.from("first") },
        { id: "example.trace", bytes: Buffer.from("second") },
      ],
    },
  },
  {
    name: "artifact count beyond the limit",
    result: {
      finalMessage: "ready",
      complete: true,
      artifacts: Array.from({ length: 33 }, (_, index) => ({
        id: `example.trace-${index}`,
        bytes: Buffer.from("trace"),
      })),
    },
  },
];

for (const receipt of invalidReceipts) {
  test(`rejects ${receipt.name} without assessing the candidate`, async () => {
    const options = await evaluation(receipt.result);
    const outcome = await runEvaluation(options);
    expect(outcome.result.execution.status).toBe("failed");
    expect(outcome.result.task.verdict).toBe("not_assessed");
    expect(outcome.result.exitCode).toBe(2);
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    const trial = defined(evidence.trials[0]);
    expect(trial.rawResult.path).toBeNull();
    expect(trial.observationCompleteness).toBe("unavailable");
    expect(trial.artifactRefs).toEqual([]);
    expect(defined(outcome.result.cases[0]).trials).toHaveLength(1);
  });
}

test("retains a failed host's raw response and artifacts before fixture cleanup", async () => {
  const bytes = Buffer.from("private diagnostic trace\n");
  const options = await evaluation({
    finalMessage: "ready",
    complete: false,
    executionFailed: true,
    artifacts: [{ id: "example.trace", bytes }],
    observations: [observation("example.receipt")],
  });
  let workspace = "";
  const host = options.host;
  options.host = {
    ...host,
    run(request) {
      workspace = request.workspace;
      return host.run(request);
    },
  };
  const outcome = await runEvaluation(options);
  expect(outcome.result.execution.status).toBe("failed");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(defined(defined(outcome.result.cases[0]).trials[0]).checks).toEqual(
    [],
  );
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  expect(await readFile(new URL(defined(trial.rawResult.path)), "utf8")).toBe(
    "ready",
  );
  const artifact = defined(
    trial.artifactRefs.find((item) => item.id === "example.trace"),
  );
  expect(await readFile(new URL(artifact.path))).toEqual(bytes);
  expect(artifact.sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(
    trial.observations.find((item) => item.id === "example.receipt"),
  ).toMatchObject({ completeness: "complete", data: { ready: true } });
  expect(workspace).not.toBe("");
  expect(existsSync(workspace)).toBe(false);
});

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

for (const grader of [
  { name: "malformed", finalMessage: "{broken", complete: true },
  { name: "incomplete", finalMessage: '{"verdicts":[]}', complete: false },
]) {
  test(`retains ${grader.name} semantic output as a grading error and cleans its workspace`, async () => {
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
    expect(existsSync(workspace)).toBe(false);
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

test("retains semantic-phase cancellation and interrupted ownership before further trial admission", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const controller = new AbortController();
  options.signal = controller.signal;
  options.runStateRoot = join(options.projectRoot, "state");
  options.trialCount = 2;
  options.jobs = 1;
  requireSemantic(options, { finalMessage: "unused", complete: true });
  let calls = 0;
  let workspace = "";
  options.semanticHost = {
    ...defined(options.semanticHost),
    run(request) {
      calls++;
      workspace = request.workspace;
      expect(request.signal).toBe(controller.signal);
      controller.abort("SIGTERM");
      return Promise.reject(new Error("grader cooperatively cancelled"));
    },
  };
  const outcome = await runEvaluation(options);
  expect(calls).toBe(1);
  expect(outcome.result.execution.status).toBe("cancelled");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(outcome.result.exitCode).toBe(143);
  expect(defined(outcome.result.cases[0]).trials).toHaveLength(1);
  expect(existsSync(workspace)).toBe(false);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expect(
    await readFile(
      new URL(defined(defined(evidence.trials[0]).rawResult.path)),
      "utf8",
    ),
  ).toBe("ready");
  const active = parseRecord(
    await readFile(
      join(options.runStateRoot, "active", `${outcome.result.runId}.json`),
      "utf8",
    ),
  );
  expect(active.status).toBe("interrupted");
});
