import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { runEvaluation } from "../../src/engine";
import { defined, parseRunEvidence } from "../fixtures/assertions";
import { createEvaluation } from "../fixtures/evaluation-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const evaluation = createEvaluation(roots);

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
  expect(existsSync(workspace)).toBe(true);
  roots.push(workspace);
});

for (const response of [
  { name: "absent", finalMessage: null, retained: false, verdict: null },
  {
    name: "exactly 64 KiB",
    finalMessage: advisoryResponse().padEnd(64 * 1024, " "),
    retained: true,
    verdict: "pass",
  },
  {
    name: "above 64 KiB",
    finalMessage: advisoryResponse().padEnd(64 * 1024 + 1, " "),
    retained: false,
    verdict: null,
  },
] as const) {
  test(`advisory review bounds raw response retention for ${response.name} output`, async () => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    options.case.fixture = {
      kind: "generated",
      commits: [{ message: "base", files: { "README.md": "base\n" } }],
    };
    let workspace = "";
    options.advisoryHost = {
      id: "example.advisory",
      model: "review-v1",
      effort: "none",
      run(request) {
        workspace = request.workspace;
        return Promise.resolve({
          finalMessage: response.finalMessage,
          complete: true,
          artifacts: [
            { id: "example.trace", bytes: Buffer.from("review trace") },
          ],
        });
      },
    };
    const { result } = await runEvaluation(options);
    expect(result.task.verdict).toBe("passed");
    expect(result.exitCode).toBe(0);
    const evidence = parseRunEvidence(
      await readFile(result.evidencePath, "utf8"),
    );
    const trial = defined(evidence.trials[0]);
    const review = defined(trial.advisoryReview);
    expect(review.status).toBe(
      response.verdict === null ? "failed" : "completed",
    );
    expect(review.assessment?.verdict ?? null).toBe(response.verdict);
    const raw = trial.artifactRefs.find(
      (item) => item.id === "sevro.advisory.response",
    );
    if (response.retained) {
      expect(await readFile(new URL(defined(raw).path), "utf8")).toBe(
        response.finalMessage,
      );
      expect(review.rawResult.path).toBe(defined(raw).path);
      expect(review.rawResult.sha256).toBe(defined(raw).sha256);
    } else {
      expect(raw).toBeUndefined();
      expect(review.rawResult.path).toBeNull();
      expect(review.rawResult.sha256).toBeNull();
    }
    const trace = defined(
      trial.artifactRefs.find(
        (item) => item.id === "sevro.advisory.example.trace",
      ),
    );
    expect(await readFile(new URL(trace.path), "utf8")).toBe("review trace");
    expect(workspace).not.toBe("");
    expect(existsSync(workspace)).toBe(response.verdict === null);
    roots.push(workspace);
  });
}
