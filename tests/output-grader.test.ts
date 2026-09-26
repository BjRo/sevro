import { expect, test } from "bun:test";
import { gradeOutput, prepareOutputChecks } from "../src/graders/output";

test("regex checks grade complete output and preflight invalid patterns", () => {
  const checks = prepareOutputChecks([
    {
      id: "ready",
      grader: "sevro.regex",
      configuration: { pattern: "^ready$" },
    },
    {
      id: "secret",
      grader: "sevro.regex",
      configuration: { pattern: "secret", negate: true },
    },
  ]);
  expect(
    gradeOutput("ready", true, checks).map((check) => check.status),
  ).toEqual(["passed", "passed"]);
  expect(
    gradeOutput("not ready secret", true, checks).map((check) => check.status),
  ).toEqual(["failed", "failed"]);
  expect(() =>
    prepareOutputChecks([
      {
        id: "broken",
        grader: "sevro.regex",
        configuration: { pattern: "(?i)ready" },
      },
    ]),
  ).toThrow(/invalid regex/);
});

test("JSON checks support pointers, exact values, and recursive containment", () => {
  const checks = prepareOutputChecks([
    {
      id: "value",
      grader: "sevro.json",
      configuration: {
        pointer: "/items/0",
        equals: { name: "alpha", tags: ["a", "b"] },
      },
    },
    {
      id: "contains",
      grader: "sevro.json",
      configuration: { pointer: "/items", contains: { name: "beta" } },
    },
  ]);
  const output =
    '```json\n{"items":[{"name":"alpha","tags":["a","b"]},{"name":"beta"}]}\n```';
  expect(
    gradeOutput(output, true, checks).map((check) => check.status),
  ).toEqual(["passed", "passed"]);
  expect(gradeOutput("{}", true, checks).map((check) => check.status)).toEqual([
    "failed",
    "failed",
  ]);
  expect(
    gradeOutput(
      '{"items":[{"name":"alpha","tags":["a","b"]}]}',
      true,
      checks,
    ).map((check) => check.status),
  ).toEqual(["passed", "failed"]);
  expect(() =>
    prepareOutputChecks([
      {
        id: "pointer",
        grader: "sevro.json",
        configuration: { pointer: "/bad~2escape" },
      },
    ]),
  ).toThrow(/pointer/);
});

test("exact JSON checks reject surrounding prose", () => {
  const checks = prepareOutputChecks([
    {
      id: "exact",
      grader: "sevro.json",
      configuration: { exactDocument: true },
    },
  ]);
  expect(
    gradeOutput('before\n```json\n{"ok":true}\n```', true, checks)[0]?.status,
  ).toBe("failed");
  expect(
    gradeOutput('```json\n{"ok":true}\n```', true, checks)[0]?.status,
  ).toBe("passed");
});

test("schema checks validate inline schemas without reading candidate paths", () => {
  const checks = prepareOutputChecks([
    {
      id: "shape",
      grader: "sevro.schema",
      configuration: {
        schema: {
          type: "object",
          required: ["status"],
          properties: { status: { const: "ready" } },
        },
      },
    },
  ]);
  expect(gradeOutput('{"status":"ready"}', true, checks)[0]?.status).toBe(
    "passed",
  );
  expect(gradeOutput('{"status":"wait"}', true, checks)[0]?.status).toBe(
    "failed",
  );
  expect(gradeOutput("not JSON", true, checks)[0]?.status).toBe("failed");
});

test("missing or incomplete observations cannot pass any output check", () => {
  const checks = prepareOutputChecks([
    { id: "ready", grader: "sevro.regex", configuration: { pattern: "ready" } },
    { id: "json", grader: "sevro.json", configuration: {} },
  ]);
  expect(
    gradeOutput("ready", false, checks).map((check) => check.status),
  ).toEqual(["unavailable", "unavailable"]);
  expect(gradeOutput(null, true, checks).map((check) => check.status)).toEqual([
    "unavailable",
    "unavailable",
  ]);
});

test("composite output checks keep text and JSON assertions in one outcome", () => {
  const [check] = prepareOutputChecks([
    {
      id: "contract",
      grader: "sevro.output",
      configuration: {
        validJson: true,
        schema: { type: "object", required: ["items"] },
        jsonPath: "/items",
        containsJson: { name: "ready" },
        expectRegex: "ready",
        notRegex: "secret",
        flags: "i",
      },
    },
  ]);
  expect(
    gradeOutput('{"items":[{"name":"READY"}]}', true, [check!])[0]?.status,
  ).toBe("failed");
  expect(
    gradeOutput('{"items":[{"name":"ready"}]}', true, [check!])[0]?.status,
  ).toBe("passed");
  expect(
    gradeOutput('before\n{"items":[{"name":"ready"}]}', true, [check!])[0]
      ?.status,
  ).toBe("failed");
  expect(
    gradeOutput('{"items":[{"name":"ready"}],"secret":true}', true, [check!])[0]
      ?.status,
  ).toBe("failed");
  expect(gradeOutput(null, true, [check!])[0]?.status).toBe("unavailable");
});

test("composite exact text matching is strict and validates patterns before execution", () => {
  const [check] = prepareOutputChecks([
    {
      id: "exact",
      grader: "sevro.output",
      configuration: {
        expectExact: "ready",
      },
    },
  ]);
  expect(gradeOutput("ready", true, [check!])[0]?.status).toBe("passed");
  expect(gradeOutput("ready\n", true, [check!])[0]?.status).toBe("failed");
  expect(() =>
    prepareOutputChecks([
      {
        id: "bad",
        grader: "sevro.output",
        configuration: {
          expectRegex: "(",
        },
      },
    ]),
  ).toThrow(/regex/);
  expect(() =>
    prepareOutputChecks([
      {
        id: "bad",
        grader: "sevro.output",
        configuration: {
          validJson: true,
          jsonPath: "/bad~2pointer",
        },
      },
    ]),
  ).toThrow(/pointer/);
});
