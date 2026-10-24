import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import baseline from "../../../examples/basic/graded.json";
import { parseCliResult } from "../../fixtures/assertions";
import { createFixture } from "../../fixtures/cli-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const fixture = createFixture(roots);

const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

async function run(args: string[], json: boolean) {
  const child = Bun.spawn(
    json ? args : args.filter((arg) => arg !== "--json"),
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test.each([false, true])(
  "CLI explains parser failures on stderr (JSON=%s)",
  async (json) => {
    const { args } = await fixture();
    const result = await run([...args, "--results-root"], json);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("--results-root");
    expect(result.stderr).toContain("argument");
    expect(result.stderr).toContain("sevro run --help");
    if (json) {
      const parsed = parseCliResult(result.stdout);
      expect(parsed).toMatchObject({
        format: "sevro.cli-result.v1",
        exitCode: 64,
        evidencePath: null,
        cases: [],
        diagnostic: { code: "sevro.invocation.invalid" },
      });
      expect(parsed.diagnostic?.message).toContain("--results-root");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    } else {
      expect(result.stdout).toBe(
        "execution=not_run grading=not_requested task=not_assessed\n",
      );
    }
  },
);

test.each([
  ["condition", "other", "passive or enforced"],
  ["threshold", "0", "greater than 0 and at most 1"],
  ["trials", "0", "positive integer"],
  ["project-root", "", "supply --project-root"],
  ["unknown-option", "value", "--unknown-option"],
])("CLI gives corrective values for --%s", async (name, value, correction) => {
  const { args } = await fixture();
  const index = args.indexOf(`--${name}`);
  if (index === -1) args.push(`--${name}`, value);
  else args[index + 1] = value;
  const result = await run(args, true);
  expect(result.code).toBe(64);
  expect(result.stderr).toContain(`--${name}`);
  expect(result.stderr).toContain(correction);
  expect(result.stderr).toContain("sevro run --help");
});

test.each([false, true])(
  "CLI explains runner storage failures on stderr (JSON=%s)",
  async (json) => {
    const { args, caseFile } = await fixture();
    const resultsRoot = join(dirname(caseFile), "results");
    await writeFile(resultsRoot, "occupied by a file");
    const result = await run(args, json);
    expect(result.code).toBe(70);
    expect(result.stderr).toContain(resultsRoot);
    expect(result.stderr).toContain("--results-root");
    expect(result.stderr).toContain("writable");
    if (json)
      expect(parseCliResult(result.stdout)).toMatchObject({
        format: "sevro.cli-result.v1",
        exitCode: 70,
        diagnostic: { code: "sevro.runner.error" },
      });
    else
      expect(result.stdout).toBe(
        "execution=not_run grading=not_requested task=not_assessed\n",
      );
  },
);

test.each([
  ["prompt", { ...baseline, prompt: "" }, "prompt", "nonempty string"],
  [
    "continuation",
    { ...baseline, followUpPrompt: "  " },
    "followUpPrompt",
    "nonblank string",
  ],
  ["fixture", { ...baseline, fixture: null }, "fixture", "object"],
  [
    "inline content",
    { ...baseline, fixture: { files: { "readme.txt": 42 } } },
    'fixture.files["readme.txt"]',
    "string",
  ],
  ["check", { ...baseline, checks: [null] }, "checks[0]", "object"],
  [
    "check configuration",
    {
      ...baseline,
      checks: [{ id: "ready", grader: "sevro.output", configuration: [] }],
    },
    "checks[0].configuration",
    "object",
  ],
  [
    "required evidence",
    { ...baseline, requiredEvidence: [42] },
    "requiredEvidence[0]",
    "string",
  ],
] as const)(
  "CLI locates invalid case %s in its source file",
  async (_, value, field, correction) => {
    const { args, caseFile } = await fixture();
    await writeFile(caseFile, JSON.stringify(value));
    const result = await run(args, true);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(caseFile);
    expect(result.stderr).toContain(field);
    expect(result.stderr).toContain(correction);
    expect(result.stderr).toContain("Correct");
    expect(parseCliResult(result.stdout)).toMatchObject({
      format: "sevro.cli-result.v1",
      evidencePath: null,
      cases: [],
    });
  },
);

test.each(["missing", "malformed JSON"])(
  "CLI locates an unreadable case: %s",
  async (problem) => {
    const { args, caseFile } = await fixture();
    if (problem === "missing") await rm(caseFile);
    else await writeFile(caseFile, "{broken");
    const result = await run(args, false);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(caseFile);
    expect(result.stderr).toContain("readable JSON");
    expect(result.stderr).toContain("--case-file");
  },
);

test("CLI identifies a missing host adapter and how to repair it", async () => {
  const { args, caseFile } = await fixture();
  const missing = join(dirname(caseFile), "missing-adapter.ts");
  args[args.indexOf("--adapter-module") + 1] = missing;
  const result = await run(args, true);
  expect(result.code).toBe(64);
  expect(result.stderr).toContain(missing);
  expect(result.stderr).toContain("--adapter-module");
  expect(result.stderr).toContain("exists and imports");
  expect(parseCliResult(result.stdout).cases).toEqual([]);
});
