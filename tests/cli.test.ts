import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const adapter = join(import.meta.dir, "fixtures", "host-adapter.ts");
const digest = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-cli-test-"));
  roots.push(projectRoot);
  const caseFile = join(projectRoot, "case.json");
  const resultsRoot = join(projectRoot, "results");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "answer",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "fixture\n" } },
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    }),
  );
  const args = [
    process.execPath,
    cli,
    "run",
    "--json",
    "--case-file",
    caseFile,
    "--adapter-module",
    adapter,
    "--project-root",
    projectRoot,
    "--results-root",
    resultsRoot,
    "--runner-build-digest",
    digest,
    "--project-digest",
    digest,
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ];
  return { args, caseFile };
}

async function invoke(args: string[], scenario = "pass") {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SEVRO_TEST_SCENARIO: scenario },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, result: JSON.parse(stdout) };
}

test("CLI emits one JSON result and uses the task exit category", async () => {
  const { args } = await fixture();
  const passed = await invoke(args);
  expect(passed.code).toBe(0);
  expect(passed.result.task.verdict).toBe("passed");
  expect(passed.result.exitCode).toBe(0);
  expect(passed.stderr).toBe("");
  expect(
    JSON.parse(await readFile(passed.result.evidencePath, "utf8")).result,
  ).toEqual(passed.result);

  const failed = await invoke(args, "fail");
  expect(failed.code).toBe(1);
  expect(failed.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "failed" },
    exitCode: 1,
  });
});

test("CLI reports invalid invocation as versioned JSON without a run", async () => {
  const { args, caseFile } = await fixture();
  const invalid = await invoke(
    args.map((arg) => (arg === caseFile ? join(caseFile, "missing") : arg)),
  );
  expect(invalid.code).toBe(64);
  expect(invalid.result).toMatchObject({
    format: "sevro.cli-result.v1",
    execution: { status: "not_run" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
    exitCode: 64,
    evidencePath: null,
    cases: [],
  });
  const badDigest = await invoke(args.map((arg) => arg === digest ? "invalid-digest" : arg));
  expect(badDigest.code).toBe(64);
  expect(badDigest.result.evidencePath).toBeNull();
});
