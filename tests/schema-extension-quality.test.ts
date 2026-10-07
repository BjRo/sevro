import { afterAll, beforeAll, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import schema from "../schemas/extension-v1.schema.json";
import validate from "../src/generated/extension.cjs";
import { assertCliResult, assertRunEvidence } from "../src/schema";
import { defined } from "./fixtures/assertions";
import {
  requiredMutationPaths,
  typedMutations,
  constraintMutations,
  optionalMutationPaths,
  remove,
  replace,
  type Path,
} from "./quality-fixtures/schema-boundaries";
import {
  exchange,
  extensionDocuments,
  type ExtensionDocument,
} from "./quality-fixtures/quality-extension-documents";

let root: string;
let documents: ExtensionDocument[];
async function retainedTrial() {
  root = await mkdtemp(join(tmpdir(), "sevro-extension-schema-quality-"));
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../src/cli.ts"),
      "run",
      "--json",
      "--case-file",
      join(import.meta.dir, "../examples/basic/graded.json"),
      "--adapter-module",
      join(import.meta.dir, "../examples/basic/host.ts"),
      "--project-root",
      root,
      "--results-root",
      join(root, "results"),
      "--condition",
      "passive",
      "--trials",
      "1",
      "--threshold",
      "1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  const result: unknown = JSON.parse(stdout);
  assertCliResult(result);
  const evidence: unknown = JSON.parse(
    await readFile(defined(result.evidencePath), "utf8"),
  );
  assertRunEvidence(evidence);
  return evidence;
}
beforeAll(async () => {
  documents = extensionDocuments(await retainedTrial());
  for (const document of documents)
    expect(validate(exchange(document)), document.name).toBe(true);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
function named(name: string): ExtensionDocument {
  return defined(documents.find((document) => document.name === name));
}
function bodySchema(document: ExtensionDocument) {
  return { $ref: `#/$defs/${document.definition}` };
}
function checkBody(
  document: ExtensionDocument,
  body: unknown,
  expected: boolean,
  reason: string,
) {
  const message = exchange(document, body);
  expect(validate(message), `${document.name}:${reason}`).toBe(expected);
}

test("rich extension documents retain every required scalar and container", () => {
  for (const document of documents) {
    for (const path of requiredMutationPaths(
      bodySchema(document),
      document.body,
      schema,
    )) {
      const mutated = remove(document.body, path);
      checkBody(document, mutated, false, `required ${JSON.stringify(path)}`);
    }
    for (const { path, replacement } of typedMutations(
      bodySchema(document),
      document.body,
      schema,
    )) {
      const mutated = replace(document.body, path, replacement);
      checkBody(document, mutated, false, `type ${JSON.stringify(path)}`);
    }
  }
});
test("rich extension documents enforce declared choices, patterns, uniqueness and closed fields", () => {
  for (const document of documents) {
    for (const { path, replacement } of constraintMutations(
      bodySchema(document),
      document.body,
      schema,
    )) {
      const mutated = replace(document.body, path, replacement);
      checkBody(document, mutated, false, `constraint ${JSON.stringify(path)}`);
    }
  }
});
test("optional extension fields may be absent without changing envelope kind", () => {
  for (const document of documents) {
    for (const path of optionalMutationPaths(
      bodySchema(document),
      document.body,
      schema,
    )) {
      const mutated = remove(document.body, path);
      checkBody(document, mutated, true, `optional ${JSON.stringify(path)}`);
    }
  }
});
test("extension envelopes require protocol, correlation ID and method at the file-format seam", () => {
  for (const document of documents) {
    const message = exchange(document);
    for (const path of [["protocol"], ["id"], ["method"]]) {
      const mutated = remove(message, path);
      expect(validate(mutated), `${document.name}:${path.join("/")}`).toBe(
        false,
      );
    }
    for (const { path, replacement } of constraintMutations(schema, message)) {
      const mutated = replace(message, path, replacement);
      expect(
        validate(mutated),
        `${document.name}:${JSON.stringify(path)}`,
      ).toBe(false);
    }
    const wrongProtocol = replace(
      message,
      ["protocol"],
      document.method === "describe"
        ? "sevro.extension.v1"
        : "sevro.discovery.v1",
    );
    expect(validate(wrongProtocol), document.name).toBe(false);
  }
});

const countBounds: Array<{
  name: string;
  path: Path;
  valid: unknown[];
  invalid: unknown[];
}> = [
  {
    name: "resolved generated",
    path: ["cases", 0, "fixture", "commits"],
    valid: [
      [],
      Array.from({ length: 128 }, () => ({
        message: "commit",
        files: { "file.txt": "content" },
      })),
    ],
    invalid: [
      Array.from({ length: 129 }, () => ({
        message: "commit",
        files: { "file.txt": "content" },
      })),
    ],
  },
  {
    name: "resolved generated",
    path: ["cases", 0, "fixture", "commits", 0, "files"],
    valid: [{ "file.txt": "" }],
    invalid: [{}],
  },
  {
    name: "resolved repository",
    path: ["cases", 0, "fixture", "hooks"],
    valid: [stringMap(32)],
    invalid: [stringMap(33)],
  },
  {
    name: "resolved repository",
    path: ["cases", 0, "fixture", "bin"],
    valid: [stringMap(64)],
    invalid: [stringMap(65)],
  },
  {
    name: "resolved generated",
    path: ["cases", 0, "fixture", "hooks"],
    valid: [stringMap(32)],
    invalid: [stringMap(33)],
  },
  {
    name: "resolved generated",
    path: ["cases", 0, "fixture", "bin"],
    valid: [stringMap(64)],
    invalid: [stringMap(65)],
  },
  {
    name: "Codex marketplace",
    path: ["fixtureSetup", "command"],
    valid: [Array.from({ length: 16 }, () => "argument")],
    invalid: [[], Array.from({ length: 17 }, () => "argument")],
  },
];
function stringMap(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `entry-${index}`,
      "#!/bin/sh\nexit 0",
    ]),
  );
}
test.each(
  countBounds.map(
    (boundary) =>
      [`${boundary.name}:${boundary.path.join("/")}`, boundary] as const,
  ),
)(
  "extension declaration cardinality boundary: %s",
  (_label, { name, path, valid, invalid }) => {
    const document = named(name);
    for (const value of valid) {
      const mutated = replace(document.body, path, value);
      checkBody(document, mutated, true, JSON.stringify(path));
    }
    for (const value of invalid) {
      const mutated = replace(document.body, path, value);
      checkBody(document, mutated, false, JSON.stringify(path));
    }
  },
);

test.each(["describe", "resolve", "prepare", "evaluate"])(
  "%s request/result/error envelopes remain exclusive",
  (method) => {
    const refusal = exchange(named(`${method} refusal`));
    const resultAndError = { ...refusal, result: {} };
    const requestAndError = { ...refusal, params: {} };
    const noBody = remove(refusal, ["error"]);
    expect(validate(resultAndError)).toBe(false);
    expect(validate(requestAndError)).toBe(false);
    expect(validate(noBody)).toBe(false);
  },
);
test("source and inline preparation content are mutually exclusive", () => {
  const document = named("Claude plugin directories");
  const both = replace(
    document.body,
    ["artifacts", 0, "sourceRef"],
    "declared-policy",
  );
  const neither = remove(document.body, ["artifacts", 0, "contentBase64"]);
  checkBody(document, both, false, "two content sources");
  checkBody(document, neither, false, "missing content source");
});
test("passed extension checks require evidence while failed or unavailable checks can have none", () => {
  const document = named("evaluated outcomes");
  const noEvidence = replace(document.body, ["checks", 0, "evidenceRefs"], []);
  checkBody(document, noEvidence, false, "passed without evidence");
  for (const status of ["failed", "unavailable"]) {
    const mutated = replace(noEvidence, ["checks", 0, "status"], status);
    checkBody(document, mutated, true, status);
  }
});
test("extension namespaced data keys refuse ordinary unnamespaced application keys", () => {
  const document = named("Claude repository skill");
  const mutated = replace(document.body, ["extensionData"], {
    ordinary: { payload: "opaque" },
  });
  checkBody(document, mutated, false, "unnamespaced key");
});
test("opaque extension data and configuration survive serialized JSON without claiming completeness", () => {
  const document = named("retained trial evaluation");
  fc.assert(
    fc.property(fc.jsonValue({ maxDepth: 3 }), (payload) => {
      const withData = replace(document.body, ["extensionData"], {
        "example.payload": payload,
      });
      const withConfiguration = replace(withData, ["configuration"], {
        payload,
      });
      const serialized: unknown = JSON.parse(
        JSON.stringify(exchange(document, withConfiguration)),
      );
      expect(validate(serialized)).toBe(true);
    }),
    { seed: 20261008, numRuns: 120, endOnFailure: true },
  );
});

test("discovery advertises compatible version lists without changing the bootstrap protocol", () => {
  const message = {
    protocol: "sevro.discovery.v1",
    id: "discovery",
    method: "describe",
    params: {
      protocols: ["sevro.extension.v1", "sevro.extension.v12"],
      engineCapabilities: ["sevro.fixture.setup", "example.future"],
      hostCapabilities: ["sevro.host.continuation"],
    },
  };
  expect(validate(message)).toBe(true);
  for (const protocols of [
    [],
    ["sevro.extension.v0"],
    ["sevro.extension.v1", "sevro.extension.v1"],
    ["sevro.discovery.v1"],
  ]) {
    const mutated = replace(message, ["params", "protocols"], protocols);
    expect(validate(mutated)).toBe(false);
  }
});
test("extension refusal messages and opaque IDs use Unicode character length bounds", () => {
  const document = named("evaluate refusal");
  const validMessage = replace(document.body, ["message"], "🙂".repeat(4096));
  const invalidMessage = replace(document.body, ["message"], "🙂".repeat(4097));
  checkBody(document, validMessage, true, "4096 characters");
  checkBody(document, invalidMessage, false, "4097 characters");
  const message = replace(exchange(document), ["id"], "🙂".repeat(128));
  const tooLong = replace(message, ["id"], "🙂".repeat(129));
  expect(validate(message)).toBe(true);
  expect(validate(tooLong)).toBe(false);
});
test.each([null, -2.5, 0, 1.25])(
  "extension metric values preserve unknown or signed measurements: %s",
  (value) => {
    const document = named("evaluated outcomes");
    const mutated = replace(document.body, ["metrics", 0, "value"], value);
    checkBody(document, mutated, true, `measurement ${String(value)}`);
  },
);

test.each(["completed", "failed", "cancelled", "not_run"])(
  "evaluation requests preserve execution category %s",
  (status) => {
    const document = named("retained trial evaluation");
    const mutated = replace(document.body, ["execution", "status"], status);
    checkBody(document, mutated, true, status);
  },
);
test.each(["complete", "partial", "unavailable"])(
  "evaluation observations preserve declared completeness %s",
  (completeness) => {
    const document = named("retained trial evaluation");
    const mutated = replace(
      document.body,
      ["observations", 0, "completeness"],
      completeness,
    );
    checkBody(document, mutated, true, completeness);
  },
);
test.each(["passed", "failed", "unavailable"])(
  "built-in results preserve %s without imposing extension evidence policy",
  (status) => {
    const document = named("retained trial evaluation");
    const mutated = replace(
      document.body,
      ["builtinChecks"],
      [
        {
          id: "builtin",
          status,
          evidenceRefs: [],
          detail: "A built-in assertion",
        },
      ],
    );
    checkBody(document, mutated, true, status);
  },
);
test.each(["passed", "failed", "not_assessed"])(
  "extension recommendation represents %s independently of check statuses",
  (recommendation) => {
    const document = named("evaluated outcomes");
    const mutated = replace(
      document.body,
      ["taskVerdictRecommendation"],
      recommendation,
    );
    checkBody(document, mutated, true, recommendation);
  },
);
test("declared string length limits accept their exact maxima", () => {
  const document = named("extension negotiation");
  for (const [path, value] of [
    [["extension", "id"], "example." + "a".repeat(120)],
    [["extension", "version"], "v".repeat(128)],
  ] as const) {
    const mutated = replace(document.body, [...path], value);
    checkBody(document, mutated, true, path.join("/"));
  }
  const outcome = named("evaluated outcomes");
  for (const length of [0, 4096]) {
    const mutated = replace(
      outcome.body,
      ["checks", 0, "detail"],
      "x".repeat(length),
    );
    checkBody(outcome, mutated, true, `detail ${length}`);
  }
});
test("extension namespaced data restrictions apply at every operation boundary", () => {
  for (const name of [
    "resolved inline",
    "prepare repository",
    "Codex marketplace",
    "retained trial evaluation",
  ]) {
    const document = named(name);
    const paths: Record<string, Path> = {
      "resolved inline": ["cases", 0, "extensionData"],
      "prepare repository": ["case", "extensionData"],
      "Codex marketplace": ["extensionData"],
      "retained trial evaluation": ["extensionData"],
    };
    const mutated = replace(document.body, defined(paths[name]), {
      "NOT.A.NAMESPACE": null,
    });
    checkBody(document, mutated, false, "invalid namespace");
  }
});
test("JSON extension envelopes refuse primitive and array roots", () => {
  const invalidRoots: unknown[] = [null, [], false, 0, "{}"];
  for (const value of invalidRoots) {
    expect(validate(value)).toBe(false);
  }
});
