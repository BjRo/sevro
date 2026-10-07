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

test.each([
  {
    label: "null root",
    value: null,
    diagnostic: "advisory assessment must be an object",
  },
  {
    label: "array root",
    value: [],
    diagnostic: "advisory assessment must be an object",
  },
  {
    label: "null dimensions",
    value: { ...valid, dimensions: null },
    diagnostic: "advisory assessment must be an object",
  },
  {
    label: "array dimensions",
    value: { ...valid, dimensions: [] },
    diagnostic: "advisory assessment must be an object",
  },
  {
    label: "unknown verdict",
    value: { ...valid, verdict: "unavailable" },
    diagnostic: "advisory verdict must be pass or fail",
  },
  {
    label: "string score",
    value: { ...valid, overallScore: "4" },
    diagnostic: "advisory scores must be integers from 1 through 5",
  },
  {
    label: "fractional score",
    value: { ...valid, overallScore: 3.5 },
    diagnostic: "advisory scores must be integers from 1 through 5",
  },
  {
    label: "zero score",
    value: { ...valid, overallScore: 0 },
    diagnostic: "advisory scores must be integers from 1 through 5",
  },
  {
    label: "score above five",
    value: { ...valid, overallScore: 6 },
    diagnostic: "advisory scores must be integers from 1 through 5",
  },
  {
    label: "invalid dimension score",
    value: {
      ...valid,
      dimensions: { ...valid.dimensions, correctness: false },
    },
    diagnostic: "advisory scores must be integers from 1 through 5",
  },
  {
    label: "nonarray strengths",
    value: { ...valid, strengths: "covered" },
    diagnostic: "advisory assessment list is invalid",
  },
  {
    label: "nonarray weaknesses",
    value: { ...valid, weaknesses: {} },
    diagnostic: "advisory assessment list is invalid",
  },
  {
    label: "33 strengths",
    value: { ...valid, strengths: Array.from({ length: 33 }, () => "covered") },
    diagnostic: "advisory assessment list is invalid",
  },
  {
    label: "33 weaknesses",
    value: {
      ...valid,
      weaknesses: Array.from({ length: 33 }, () => "needs work"),
    },
    diagnostic: "advisory assessment list is invalid",
  },
])("advisory external JSON refuses $label", ({ value, diagnostic }) => {
  expect(() => parseAdvisoryAssessment(JSON.stringify(value))).toThrow(
    diagnostic,
  );
});

test("advisory assessment accepts the exact list bound and retains a valid low-score failure", () => {
  const assessment: AdvisoryAssessment = {
    ...valid,
    verdict: "fail",
    overallScore: 1,
    strengths: Array.from({ length: 32 }, () => "bounded strength"),
    weaknesses: Array.from({ length: 32 }, () => "bounded weakness"),
  };
  expect(parseAdvisoryAssessment(JSON.stringify(assessment))).toEqual(
    assessment,
  );
});

test("advisory prompt records omitted check detail as unknown without inventing evidence", () => {
  const prompt = advisoryPrompt("Review the change", [
    { id: "missing", grader: "sevro.regex", status: "unavailable" },
  ]);
  expect(prompt).toContain(
    '[{"id":"missing","status":"unavailable","detail":null}]',
  );
  expect(prompt).not.toContain('"detail":""');
});

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
