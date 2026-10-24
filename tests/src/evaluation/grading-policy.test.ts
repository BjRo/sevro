import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runEvaluation, type HostAdapter } from "../../../src/engine";
import { defined, parseRunEvidence } from "../../fixtures/assertions";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import { createCodexFixture } from "../../fixtures/runtime-host-fixtures";

const roots: string[] = [];

const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const codexFixture = createCodexFixture(roots);

// Keep the public evaluation invocation and both role outcomes together; bounded by the 200-line test rule.
// eslint-disable-next-line max-lines-per-function
test("evaluation applies the selected runtime policy to semantic and advisory hosts", async () => {
  const { root } = await codexFixture();
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      if (
        request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE !== "selected"
      )
        throw new Error("runtime unavailable");
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const advisoryHost: HostAdapter = {
    ...host,
    id: "runtime.advisory",
    run(request) {
      if (
        request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE !== "selected"
      )
        throw new Error("runtime unavailable");
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          verdict: "pass",
          overallScore: 5,
          dimensions: {
            correctness: 5,
            maintainability: 5,
            testQuality: 5,
            scopeDiscipline: 5,
          },
          strengths: [],
          weaknesses: [],
          summary: "Ready",
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "results-evaluation"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    advisoryHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { SEVRO_RUNTIME_SAMPLE: "selected" },
      readOnlyRoots: [],
    },
    case: {
      id: "runtime-roles",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [{ message: "baseline", files: { "README.md": "baseline" } }],
      },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
      requiredEvidence: [],
    },
  });
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(result.task.verdict, JSON.stringify(evidence.trials)).toBe("passed");
  expect(defined(evidence.trials[0]).advisoryReview?.status).toBe("completed");
});

test("response-only semantic grading omits implicit dependency seeds", async () => {
  const { root } = await codexFixture();
  const received: unknown[] = [];
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      received.push(request.runtimePolicy?.seeds);
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "semantic-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      seeds: [
        {
          source: join(root, "dependencies"),
          target: "cache",
          sha256: "c".repeat(64),
        },
      ],
    },
    case: {
      id: "response-runtime",
      prompt: "Return ready.",
      fixture: { files: {} },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
      requiredEvidence: [],
    },
  });
  expect(result.task.verdict).toBe("passed");
  expect(received).toEqual([[]]);
});

test("response-only semantic grading preserves original seed source denial", async () => {
  const { root } = await codexFixture();
  const received: unknown[] = [];
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      received.push(request.runtimePolicy);
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "semantic-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      seeds: [
        {
          source: join(root, "dependencies"),
          target: "cache",
          sha256: "c".repeat(64),
        },
      ],
    },
    case: {
      id: "response-runtime",
      prompt: "Return ready.",
      fixture: { files: {} },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
      requiredEvidence: [],
    },
  });
  expect(result.task.verdict).toBe("passed");
  expect(received).toMatchObject([
    { seeds: [], seedReadDenyRoots: [join(root, "dependencies")] },
  ]);
});

test("response-only semantic grading retains explicitly selected semantic seeds", async () => {
  const { root } = await codexFixture();
  const received: unknown[] = [];
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      received.push(request.runtimePolicy?.seeds);
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "semantic-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      seeds: [
        {
          source: join(root, "dependencies"),
          target: "cache",
          sha256: "c".repeat(64),
          roles: ["semantic"],
        },
      ],
    },
    case: {
      id: "response-runtime",
      prompt: "Return ready.",
      fixture: { files: {} },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
      requiredEvidence: [],
    },
  });
  expect(result.task.verdict).toBe("passed");
  expect(received).toEqual([
    [
      {
        source: join(root, "dependencies"),
        target: "cache",
        sha256: "c".repeat(64),
        roles: ["semantic"],
      },
    ],
  ]);
});

test("evaluation refuses credential-bearing runtime policy before creating results", async () => {
  const { root } = await codexFixture();
  const resultsRoot = join(root, "private-results");
  const host: HostAdapter = {
    id: "runtime.stub",
    model: "synthetic",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  expect(
    runEvaluation({
      projectRoot: root,
      resultsRoot,
      runnerBuildDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
      host,
      case: {
        id: "credential-runtime",
        prompt: "Return ready",
        fixture: { files: {} },
        checks: [],
        requiredEvidence: [],
      },
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { OPENAI_API_KEY: "synthetic-private-value" },
        readOnlyRoots: [],
      },
    }),
  ).rejects.toThrow("protected");
  expect(await Bun.file(resultsRoot).exists()).toBe(false);
});

test("Codex refuses native-goal runtime policy on the exec route", async () => {
  const { host, workspace } = await codexFixture();
  expect(
    host.run({
      prompt: "Complete the native goal.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        hooks: { nativeGoal: true },
      },
    }),
  ).rejects.toThrow("app-server");
});

test("evaluation snapshots runtime values before a caller changes them", async () => {
  const { root } = await codexFixture();
  const policy = {
    format: "sevro.runtime.v1" as const,
    environment: { SEVRO_RUNTIME_SAMPLE: "selected" },
    readOnlyRoots: [],
  };
  const host: HostAdapter = {
    id: "runtime.stub",
    model: "synthetic",
    effort: "none",
    run() {
      policy.environment.SEVRO_RUNTIME_SAMPLE = "changed";
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [
            {
              id: "meaning",
              verdict:
                request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE ===
                "selected"
                  ? "pass"
                  : "fail",
              reason: "Runtime value observed",
            },
          ],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "snapshot-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    case: {
      id: "snapshot-runtime",
      prompt: "Return ready",
      fixture: { files: {} },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The runtime is selected." },
        },
      ],
      requiredEvidence: [],
    },
    runtimePolicy: policy,
  });
  expect(result.task.verdict).toBe("passed");
});

test("artifact semantic grading keeps implicit dependency seeds", async () => {
  const { root } = await codexFixture();
  const received: unknown[] = [];
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const seed = {
    source: join(root, "dependencies"),
    target: "cache",
    sha256: "c".repeat(64),
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      received.push(request.runtimePolicy?.seeds);
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "semantic-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      seeds: [seed],
    },
    case: {
      id: "artifact-runtime",
      prompt: "Return ready.",
      fixture: { files: { "answer.md": "ready" } },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: {
            proposition: "The artifact is ready.",
            artifactPath: "answer.md",
          },
        },
      ],
      requiredEvidence: [],
    },
  });
  expect(result.task.verdict).toBe("passed");
  expect(received).toEqual([[seed]]);
});
