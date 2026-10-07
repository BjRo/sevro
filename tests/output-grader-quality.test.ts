import { expect, test } from "bun:test";
import {
  gradeOutput,
  prepareOutputChecks,
  type OutputCheckDeclaration,
} from "../src/graders/output";
import { defined } from "./fixtures/assertions";

function outcome(
  grader: OutputCheckDeclaration["grader"],
  configuration: Record<string, unknown>,
  text: string,
) {
  return defined(
    gradeOutput(
      text,
      true,
      prepareOutputChecks([{ id: "contract", grader, configuration }]),
    )[0],
  );
}

const invalidConfigurations: Array<
  [OutputCheckDeclaration["grader"], Record<string, unknown>, RegExp]
> = [
  ["sevro.regex", { pattern: "ready", extra: true }, /unsupported/],
  ["sevro.regex", { pattern: 3 }, /invalid regex check/],
  ["sevro.regex", { pattern: "ready", negate: "yes" }, /invalid regex check/],
  ["sevro.regex", { pattern: "ready", flags: 1 }, /invalid regex/],
  ["sevro.json", { pointer: 1 }, /pointer must be a string/],
  ["sevro.json", { exactDocument: 1 }, /exactDocument/],
  ["sevro.json", { contains: { nested: [{ $regex: 1 }] } }, /subset regex/],
  ["sevro.json", { contains: [{ $regex: "(" }] }, /subset regex/],
  ["sevro.schema", { schema: null }, /inline JSON Schema object/],
  [
    "sevro.schema",
    { schema: { type: "not-a-type" } },
    /invalid inline JSON Schema/,
  ],
  ["sevro.output", { validJson: "yes" }, /validJson/],
  ["sevro.output", { expectExact: false }, /expectExact/],
  ["sevro.output", { expectJson: null }, /require a pointer/],
  ["sevro.output", { containsJson: [] }, /require a pointer/],
  ["sevro.output", { flags: "i" }, /require a pattern/],
];
test.each(invalidConfigurations)(
  "output grader %s refuses invalid configuration %j",
  (grader, configuration, diagnostic) => {
    expect(() =>
      prepareOutputChecks([{ id: "contract", grader, configuration }]),
    ).toThrow(diagnostic);
  },
);

test.each(["", "same"])(
  "output checks refuse empty or duplicate IDs: %s",
  (id) => {
    const declaration: OutputCheckDeclaration = {
      id,
      grader: "sevro.json",
      configuration: {},
    };
    expect(() => prepareOutputChecks([declaration, declaration])).toThrow(
      /duplicate or empty/,
    );
  },
);

test("JSON pointer escaping selects the declared key and refuses scalar traversal", () => {
  expect(
    outcome(
      "sevro.json",
      { pointer: "/a~1b/~0key", equals: false },
      '{"a/b":{"~key":false}}',
    ),
  ).toMatchObject({ status: "passed", detail: "ok" });
  expect(
    outcome("sevro.json", { pointer: "/a/b" }, '{"a":null}'),
  ).toMatchObject({
    status: "failed",
    detail: "JSON pointer does not resolve",
  });
  expect(outcome("sevro.json", { equals: [1, 2] }, "[2,1]")).toMatchObject({
    status: "failed",
    detail: "JSON value did not equal expectation",
  });
});

test.each([
  ['[{"tags":["red","blue"],"name":"alpha"}]', "passed"],
  ['[{"tags":["red"],"name":"alpha"}]', "failed"],
  ['[{"tags":"blue","name":"alpha"}]', "failed"],
  ['[{"tags":["red","blue"],"name":4}]', "failed"],
  ["[null]", "failed"],
  ["{}", "failed"],
] as const)("recursive JSON containment grades %s as %s", (text, status) => {
  expect(
    outcome(
      "sevro.json",
      { contains: { tags: ["red", "blue"], name: { $regex: "^a" } } },
      text,
    ).status,
  ).toBe(status);
});

test.each([
  ['prose\n```json\n{"ok":true}\n```', "passed"],
  ["```json\n{broken\n```", "failed"],
  ["```json\n{}\n```\n```json\n{}\n```", "failed"],
] as const)(
  "JSON document recovery accepts only one valid fence: %s",
  (text, status) => {
    expect(outcome("sevro.json", {}, text).status).toBe(status);
  },
);

test("composite output checks retain the first independent failure", () => {
  const configuration = {
    validJson: true,
    schema: { type: "object", required: ["status"] },
    jsonPath: "/status",
    expectJson: "ready",
    expectExact: '{"status":"ready"}',
  };
  expect(outcome("sevro.output", configuration, "not JSON").detail).toBe(
    "output is not valid JSON",
  );
  expect(outcome("sevro.output", configuration, "{}").detail).toBe(
    "output did not match JSON Schema",
  );
  expect(
    outcome("sevro.output", configuration, '{"status":"wait"}').detail,
  ).toBe("JSON value did not equal expectation");
  expect(
    outcome("sevro.output", configuration, '{"status": "ready"}').detail,
  ).toBe("exact output did not match");
  expect(
    outcome("sevro.output", configuration, '{"status":"ready"}').status,
  ).toBe("passed");
});

test("global regex checks reset between repeated observations", () => {
  const checks = prepareOutputChecks([
    {
      id: "global",
      grader: "sevro.regex",
      configuration: { pattern: "ready", flags: "g" },
    },
  ]);
  for (let repeat = 0; repeat < 5; repeat++)
    expect(defined(gradeOutput("ready", true, checks)[0]).status).toBe(
      "passed",
    );
});
