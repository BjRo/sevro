import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSemanticArtifact,
  validateArtifactPath,
} from "../src/graders/artifact";
import {
  gradeOutput,
  prepareOutputChecks,
  type OutputCheckDeclaration,
} from "../src/graders/output";
import { defined } from "./fixtures/assertions";

const artifactRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    artifactRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each(
  [
    null,
    false,
    1,
    [],
    {},
    "",
    " ",
    "/answer.md",
    "../answer.md",
    "docs/../answer.md",
    ".git/answer.md",
    "docs\\answer.md",
    "doc*/answer.md",
    "answer**.md",
  ].map((path: unknown) => ({ path })),
)(
  "semantic artifact declarations refuse invalid ordinary value $path",
  ({ path }) => {
    expect(() => {
      validateArtifactPath(path);
    }).toThrow("semantic artifact path must be relative");
  },
);

test("semantic artifact directory links stay contained and preserve external document bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-artifact-containment-"));
  artifactRoots.push(root);
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await mkdir(external);
  await writeFile(join(workspace, "docs", "answer.md"), "contained answer");
  await writeFile(join(external, "answer.md"), "external answer");
  await symlink("docs", join(workspace, "contained"));
  await symlink(external, join(workspace, "outside"));
  expect(await readSemanticArtifact(workspace, "contained/*.md")).toEqual({
    path: "docs/answer.md",
    content: "contained answer",
  });
  expect(readSemanticArtifact(workspace, "outside/answer.md")).rejects.toThrow(
    "semantic artifact directory escapes the fixture",
  );
  expect(await readFile(join(external, "answer.md"), "utf8")).toBe(
    "external answer",
  );
});

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
