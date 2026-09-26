import { expect, test } from "bun:test";
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
