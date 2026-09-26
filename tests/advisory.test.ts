import { expect, test } from "bun:test";
import {
  advisoryPrompt,
  parseAdvisoryAssessment,
  type AdvisoryAssessment,
} from "../src/advisory";

const valid: AdvisoryAssessment = {
  verdict: "pass",
  overallScore: 4,
  dimensions: {
    correctness: 4,
    maintainability: 4,
    testQuality: 3,
    scopeDiscipline: 5,
  },
  strengths: ["Covered the changed behavior"],
  weaknesses: [],
  summary: "The change meets the task.",
};

test("advisory assessment accepts a structured independent review", () => {
  expect(parseAdvisoryAssessment(JSON.stringify(valid))).toEqual(valid);
  expect(
    parseAdvisoryAssessment(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``),
  ).toEqual(valid);
});

test("advisory assessment rejects weak passes, extra fields, and oversized output", () => {
  expect(() =>
    parseAdvisoryAssessment(JSON.stringify({ ...valid, overallScore: 2 })),
  ).toThrow(/score/);
  expect(() =>
    parseAdvisoryAssessment(
      JSON.stringify({ ...valid, taskVerdict: "passed" }),
    ),
  ).toThrow(/fields/);
  expect(() =>
    parseAdvisoryAssessment(JSON.stringify({ ...valid, summary: "" })),
  ).toThrow(/nonempty/);
  expect(() => parseAdvisoryAssessment("x".repeat(65537))).toThrow(/64 KiB/);
});

test("advisory prompt keeps task and check facts explicit and bounded", () => {
  const prompt = advisoryPrompt("Add validation", [
    {
      id: "test",
      grader: "sevro.shell",
      status: "passed",
      detail: "exit code 0",
    },
  ]);
  expect(prompt).toContain('"Add validation"');
  expect(prompt).toContain('"status":"passed"');
  expect(prompt).toContain("review is advisory");
  expect(() => advisoryPrompt("", [])).toThrow(/bounds/);
});
