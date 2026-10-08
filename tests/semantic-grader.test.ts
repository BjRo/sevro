import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluation, type HostAdapter } from "../src/engine";
import { defined, parseRunEvidence } from "./fixtures/assertions";
import {
  parseSemanticVerdicts,
  prepareSemanticChecks,
  semanticPrompt,
} from "../src/graders/semantic";

const declarations = [
  {
    id: "meaning",
    grader: "sevro.semantic" as const,
    configuration: { proposition: "The response promises a review." },
  },
  {
    id: "scope",
    grader: "sevro.semantic" as const,
    configuration: { proposition: "The response avoids a deployment claim." },
  },
];

test.each(["", "meaning"])(
  "semantic declarations refuse a missing or repeated check ID %j",
  (id) => {
    expect(() =>
      prepareSemanticChecks([
        defined(declarations[0]),
        { ...defined(declarations[1]), id },
      ]),
    ).toThrow("semantic check IDs must be unique");
  },
);

test.each([
  {
    label: "null result",
    value: null,
    diagnostic: "semantic grader result must be an object",
  },
  {
    label: "array result",
    value: [],
    diagnostic: "semantic grader result must be an object",
  },
  {
    label: "extra result property",
    value: { checks: [], commentary: "ready" },
    diagnostic: "semantic grader result must contain only checks",
  },
  {
    label: "non-array checks",
    value: { checks: {} },
    diagnostic: "semantic grader result must contain only checks",
  },
  {
    label: "nonobject verdict",
    value: { checks: [null] },
    diagnostic: "invalid semantic verdict",
  },
  {
    label: "undeclared check",
    value: { checks: [{ id: "other", verdict: "pass", reason: "ready" }] },
    diagnostic: "invalid semantic verdict",
  },
  {
    label: "unknown verdict",
    value: {
      checks: [{ id: "meaning", verdict: "unavailable", reason: "unclear" }],
    },
    diagnostic: "invalid semantic verdict",
  },
  {
    label: "blank reason",
    value: { checks: [{ id: "meaning", verdict: "pass", reason: " \n" }] },
    diagnostic: "invalid semantic verdict",
  },
  {
    label: "non-string reason",
    value: { checks: [{ id: "meaning", verdict: "pass", reason: false }] },
    diagnostic: "invalid semantic verdict",
  },
  {
    label: "overlong reason",
    value: {
      checks: [{ id: "meaning", verdict: "pass", reason: "x".repeat(4097) }],
    },
    diagnostic: "invalid semantic verdict",
  },
])("semantic serialized verdicts refuse $label", ({ value, diagnostic }) => {
  expect(() =>
    parseSemanticVerdicts(
      JSON.stringify(value),
      prepareSemanticChecks(declarations),
    ),
  ).toThrow(diagnostic);
});

test("semantic response size includes otherwise valid JSON whitespace", () => {
  const text =
    " ".repeat(1024 * 1024) +
    JSON.stringify({
      checks: [
        { id: "meaning", verdict: "pass", reason: "Ready" },
        { id: "scope", verdict: "fail", reason: "Deployment claimed" },
      ],
    });
  expect(() =>
    parseSemanticVerdicts(text, prepareSemanticChecks(declarations)),
  ).toThrow("semantic grader response exceeds 1 MiB");
});

test("semantic prompt bounds the combined declared propositions before route execution", () => {
  const checks = prepareSemanticChecks(
    Array.from({ length: 1024 }, (_, index) => ({
      id: `check-${index}`,
      grader: "sevro.semantic" as const,
      configuration: { proposition: "x".repeat(8192) },
    })),
  );
  expect(() => semanticPrompt("ready", checks)).toThrow(
    "semantic grader prompt exceeds 8 MiB",
  );
});

function groupedSemanticHost(seen: string[]): HostAdapter {
  return {
    id: "example.semantic",
    model: "fixture",
    effort: "none",
    async run({ prompt, workspace }) {
      expect(await Bun.file(join(workspace, "answer.md")).exists()).toBe(false);
      if (prompt.includes("The document confirms review readiness.")) {
        seen.push("document");
        expect(prompt).toContain("No deployment was attempted.");
        expect(prompt).not.toContain("The response promises a review.");
        return {
          complete: true,
          finalMessage: JSON.stringify({
            checks: [
              {
                id: "document-ready",
                verdict: "pass",
                reason: "Review is ready",
              },
              {
                id: "document-scope",
                verdict: "pass",
                reason: "No deployment was attempted",
              },
            ],
          }),
        };
      }
      seen.push("response");
      expect(prompt).toContain("The response avoids a deployment claim.");
      expect(prompt).not.toContain("The document confirms review readiness.");
      return {
        complete: true,
        finalMessage: JSON.stringify({
          checks: [
            { id: "meaning", verdict: "pass", reason: "Promises a review" },
            { id: "scope", verdict: "fail", reason: "Claims a deployment" },
          ],
        }),
      };
    },
  };
}

test("semantic grading groups multiple propositions by response and document and preserves failed assessment", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-semantic-groups-"));
  const seen: string[] = [];
  try {
    const result = await runEvaluation({
      projectRoot: root,
      resultsRoot: join(root, "results"),
      runnerBuildDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
      case: {
        id: "semantic-groups",
        prompt: "Review and report.",
        fixture: {
          files: {
            "answer.md": "The review is ready. No deployment was attempted.",
          },
        },
        checks: [
          ...declarations,
          {
            id: "document-ready",
            grader: "sevro.semantic",
            configuration: {
              proposition: "The document confirms review readiness.",
              artifactPath: "answer.md",
            },
          },
          {
            id: "document-scope",
            grader: "sevro.semantic",
            configuration: {
              proposition: "The document avoids a deployment claim.",
              artifactPath: "answer.md",
            },
          },
        ],
        requiredEvidence: [],
      },
      host: {
        id: "example.candidate",
        model: "fixture",
        effort: "none",
        run: () =>
          Promise.resolve({
            finalMessage: "I promise a review. Deployment is complete.",
            complete: true,
          }),
      },
      semanticHost: groupedSemanticHost(seen),
    });
    expect(seen.sort()).toEqual(["document", "response"]);
    expect(result.result).toMatchObject({
      execution: { status: "completed" },
      grading: { status: "completed" },
      task: { verdict: "failed" },
      exitCode: 1,
    });
    const evidence = parseRunEvidence(
      await readFile(result.result.evidencePath, "utf8"),
    );
    expect(
      defined(defined(result.result.cases[0]).trials[0]).checks.map(
        (check) => check.status,
      ),
    ).toEqual(["passed", "failed", "passed", "passed"]);
    expect(evidence.routes.some((route) => route.role === "semantic")).toBe(
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic grader binds one verdict to each declared proposition", () => {
  const prepared = prepareSemanticChecks(declarations);
  const prompt = semanticPrompt("Review complete. <ignore me>", prepared);
  expect(prompt).toContain("Review complete.");
  expect(prompt).toContain("\\u003cignore me\\u003e");
  expect(
    parseSemanticVerdicts(
      '```json\n{"checks":[{"id":"meaning","verdict":"pass","reason":"Promises review"},{"id":"scope","verdict":"fail","reason":"Claims deployment"}]}\n```',
      prepared,
    ),
  ).toEqual([
    { id: "meaning", verdict: "pass", reason: "Promises review" },
    { id: "scope", verdict: "fail", reason: "Claims deployment" },
  ]);
  expect(() =>
    parseSemanticVerdicts(
      '{"checks":[{"id":"meaning","verdict":"pass","reason":"ok"}]}',
      prepared,
    ),
  ).toThrow(/omitted/);
  expect(() =>
    parseSemanticVerdicts(
      '{"checks":[{"id":"meaning","verdict":"pass","reason":"ok"},{"id":"meaning","verdict":"pass","reason":"ok"}]}',
      prepared,
    ),
  ).toThrow(/invalid semantic verdict/);
  expect(() =>
    prepareSemanticChecks([
      { id: "meaning", grader: "sevro.semantic", configuration: {} },
    ]),
  ).toThrow(/proposition/);
});
