import { afterAll, beforeAll, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import cliSchema from "../schemas/cli-result-v1.schema.json";
import runSchema from "../schemas/run-evidence-v1.schema.json";
import reportSchema from "../schemas/report-v1.schema.json";
import {
  assertCliResult,
  assertRunEvidence,
  assertReport,
} from "../src/schema";
import {
  requiredMutationPaths,
  typedMutations,
  constraintMutations,
  optionalMutationPaths,
  remove,
  replace,
} from "./quality-fixtures/schema-boundaries";
import type { Path } from "./quality-fixtures/schema-boundaries";
import {
  richCli,
  richEvidence,
  richReport,
} from "./quality-fixtures/rich-schema-results";

type Document = {
  name: string;
  value: unknown;
  schema: unknown;
  assert: (value: unknown) => void;
};
let root: string;
const documents: Document[] = [];

const boundaryCases: Array<{
  name: string;
  path: Path;
  valid: unknown[];
  invalid: unknown[];
}> = [
  {
    name: "CLI result",
    path: ["exitCode"],
    valid: [0, 1, 2, 3, 4, 64, 70, 130, 143],
    invalid: [-1, 5, 65, 71, 144, 1.5],
  },
  {
    name: "CLI result",
    path: ["cases", 0, "trials", 0, "trial"],
    valid: [1, 2],
    invalid: [-1, 0, 1.5],
  },
  {
    name: "report",
    path: ["rows", 0, "taskPassRate"],
    valid: [null, 0, 0.5, 1],
    invalid: [-0.01, 1.01],
  },
  {
    name: "report",
    path: ["rows", 0, "inputTokens"],
    valid: [null, 0, 2],
    invalid: [-1, 0.5],
  },
  {
    name: "report",
    path: ["rows", 0, "candidateDurationMs"],
    valid: [null, 0, 0.1],
    invalid: [-0.1],
  },
  {
    name: "report",
    path: ["rows", 0, "costUsd"],
    valid: [null, 0, 0.001],
    invalid: [-0.001],
  },
  {
    name: "report",
    path: ["rows", 0, "runnerBuildDigest"],
    valid: [null, "a".repeat(64)],
    invalid: ["a".repeat(63), "A".repeat(64)],
  },
  {
    name: "report",
    path: ["summary", "cases"],
    valid: [0, 1],
    invalid: [-1, 0.5],
  },
  {
    name: "rich report",
    path: ["rows", 0, "evaluationDigest"],
    valid: [null, "a".repeat(64)],
    invalid: ["A".repeat(64), "a".repeat(63), 42],
  },
  {
    name: "rich report",
    path: ["rows", 0, "candidateRoute"],
    valid: [null, { host: "fixture", model: "model", effort: "none" }],
    invalid: [
      [],
      { host: "fixture", model: "model", effort: "none", extra: true },
    ],
  },
  ...["host", "model", "effort"].map((field) => ({
    name: "rich report",
    path: ["rows", 0, "candidateRoute", field],
    valid: ["fixture"],
    invalid: ["", 42],
  })),
];

function documentNamed(name: string): Document {
  const selected = documents.find((document) => document.name === name);
  if (!selected) throw new Error(`Missing schema fixture: ${name}`);
  return selected;
}

test("serialized result schemas enforce numeric bounds, integer counts, digest spelling and exit enums", () => {
  for (const boundary of boundaryCases) {
    const document = documentNamed(boundary.name);
    for (const value of boundary.valid) {
      const mutated = replace(document.value, boundary.path, value);
      document.assert(mutated);
    }
    for (const value of boundary.invalid) {
      const mutated = replace(document.value, boundary.path, value);
      expect(
        () => {
          document.assert(mutated);
        },
        `${boundary.name}:${JSON.stringify(boundary.path)}=${JSON.stringify(value)}`,
      ).toThrow();
    }
  }
});

test("serialized state consistency refuses passed tasks after execution or grading failure", () => {
  const document = documentNamed("CLI result");
  for (const execution of ["failed", "cancelled", "not_run"]) {
    const mutated = replace(document.value, ["execution", "status"], execution);
    expect(() => {
      document.assert(mutated);
    }).toThrow();
  }
  for (const grading of ["error", "unavailable", "not_requested"]) {
    const mutated = replace(document.value, ["grading", "status"], grading);
    expect(() => {
      document.assert(mutated);
    }).toThrow();
  }
  const report = documentNamed("report");
  const emptyInputs = replace(report.value, ["inputs"], []);
  expect(() => {
    report.assert(emptyInputs);
  }).toThrow();
});
async function command(args: string[]): Promise<unknown> {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`Schema fixture CLI exited ${code}: ${stderr}`);
  return JSON.parse(stdout) as unknown;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sevro-schema-properties-"));
  const cli = await command([
    "run",
    "--json",
    "--case-file",
    resolve(import.meta.dir, "../examples/basic/graded.json"),
    "--adapter-module",
    resolve(import.meta.dir, "../examples/basic/host.ts"),
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
  ]);
  assertCliResult(cli);
  if (!cli.evidencePath)
    throw new Error("Schema fixture lacks retained evidence");
  const evidence: unknown = JSON.parse(
    await readFile(cli.evidencePath, "utf8"),
  );
  assertRunEvidence(evidence);
  const file = join(root, "result.json");
  await writeFile(file, JSON.stringify(cli));
  const report = await command(["report", "--json", "--result-file", file]);
  assertReport(report);
  documents.push(
    {
      name: "rich CLI result",
      value: richCli(cli),
      schema: cliSchema,
      assert: assertCliResult,
    },
    {
      name: "rich retained evidence",
      value: richEvidence(evidence),
      schema: runSchema,
      assert: assertRunEvidence,
    },
    {
      name: "rich report",
      value: richReport(report),
      schema: reportSchema,
      assert: assertReport,
    },
    {
      name: "CLI result",
      value: cli,
      schema: cliSchema,
      assert: assertCliResult,
    },
    {
      name: "retained evidence",
      value: evidence,
      schema: runSchema,
      assert: assertRunEvidence,
    },
    {
      name: "report",
      value: report,
      schema: reportSchema,
      assert: assertReport,
    },
  );
}, 15000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("real serialized results reject wrong JSON types at unconditional typed boundaries", () => {
  for (const document of documents) {
    const mutations = typedMutations(document.schema, document.value);
    expect(mutations.length, document.name).toBeGreaterThan(10);
    for (const { path, replacement } of mutations) {
      const mutated = replace(document.value, path, replacement);
      expect(
        () => {
          document.assert(mutated);
        },
        `${document.name}: ${JSON.stringify(path)}`,
      ).toThrow();
    }
  }
});

test("serialized contracts refuse undeclared fields, duplicate evidence, invalid choices and declared bounds", () => {
  for (const document of documents) {
    document.assert(document.value);
    const mutations = constraintMutations(document.schema, document.value);
    expect(mutations.length, document.name).toBeGreaterThan(10);
    for (const { path, replacement } of mutations) {
      const mutated = replace(document.value, path, replacement);
      expect(
        () => {
          document.assert(mutated);
        },
        `${document.name}:${JSON.stringify(path)}`,
      ).toThrow();
    }
  }
});

test("serialized contracts retain meaning when declared optional diagnostics and evidence are absent", () => {
  for (const document of documents) {
    const paths = optionalMutationPaths(document.schema, document.value);
    for (const path of paths) document.assert(remove(document.value, path));
  }
});

test("real serialized results refuse lost required state at every populated schema boundary", () => {
  for (const document of documents) {
    document.assert(document.value);
    const paths = requiredMutationPaths(document.schema, document.value);
    expect(paths.length, document.name).toBeGreaterThan(10);
    // The published required-field declaration supplies the oracle: removal is
    // invalid. The test does not recalculate validator decisions or counters.
    for (const path of paths) {
      const mutated = remove(document.value, path);
      expect(
        () => {
          document.assert(mutated);
        },
        `${document.name}: ${JSON.stringify(path)}`,
      ).toThrow();
    }
    const roots = paths.filter((path) => path.length === 1);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...roots), {
          minLength: 2,
          maxLength: 2,
          selector: (path) => JSON.stringify(path),
        }),
        (selected) => {
          const [first, second] = selected;
          if (!first || !second)
            throw new Error("Expected two distinct root fields");
          const mutated = remove(remove(document.value, first), second);
          expect(() => {
            document.assert(mutated);
          }).toThrow();
        },
      ),
      { seed: 20261007, numRuns: 200, endOnFailure: true },
    );
  }
}, 15000);
