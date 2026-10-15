import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "../fixtures/cli-fixtures";
import {
  defined,
  expectUnknown,
  parseCliResult,
  parseRunEvidence,
} from "../fixtures/assertions";
import { runEvaluation } from "../../src/engine";
import baseline from "../../examples/basic/graded.json";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sevro-workflow-")));
  roots.push(root);
  return root;
}

async function run(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("response initializer creates an assessed project with a real negative control and refuses overwrites", async () => {
  const root = await directory();
  const initialized = await run(root, [
    "init",
    "--template",
    "response",
    "--directory",
    "sample",
  ]);
  expect(initialized.code, initialized.stderr).toBe(0);
  expect(initialized.stdout).toContain(
    "sevro run --run-manifest-file run.json --dry",
  );
  const sample = join(root, "sample");
  const args = ["run", "--run-manifest-file", "run.json", "--json"];
  const passed = await run(sample, args);
  expect(passed.code, passed.stderr).toBe(0);
  expect(parseCliResult(passed.stdout).task.verdict).toBe("passed");
  const failed = await run(sample, args, { SEVRO_TEMPLATE_FAIL: "1" });
  expect(failed.code, failed.stderr).toBe(1);
  expect(parseCliResult(failed.stdout).task.verdict).toBe("failed");
  const before = await readFile(join(sample, "case.json"), "utf8");
  const duplicate = await run(root, ["init", "--directory", "sample"]);
  expect(duplicate.code).toBe(64);
  expect(duplicate.stderr).toContain("already exists");
  expect(await readFile(join(sample, "case.json"), "utf8")).toBe(before);
  expect(defined(parseCliResult(passed.stdout).evidencePath)).toStartWith(
    join(sample, ".sevro", "results"),
  );
});

test("coding initializer grades the edited code with positive and negative input assertions", async () => {
  const root = await directory();
  const initialized = await run(root, [
    "init",
    "--template",
    "coding",
    "--directory",
    "coding",
  ]);
  expect(initialized.code, initialized.stderr).toBe(0);
  const sample = join(root, "coding");
  const args = ["run", "--run-manifest-file", "run.json", "--json"];
  const passed = await run(sample, args);
  expect(passed.code, passed.stderr).toBe(0);
  expect(
    parseCliResult(passed.stdout).cases[0]?.trials[0]?.checks,
  ).toMatchObject([{ id: "addition", status: "passed" }]);
  const failed = await run(sample, args, { SEVRO_TEMPLATE_FAIL: "1" });
  expect(failed.code, failed.stderr).toBe(1);
  expect(
    parseCliResult(failed.stdout).cases[0]?.trials[0]?.checks,
  ).toMatchObject([{ id: "addition", status: "failed" }]);
});

test("repository skill initializer prepares the actual mount and requires explicit native prerequisites", async () => {
  const root = await directory();
  const initialized = await run(root, [
    "init",
    "--template",
    "repository-skill",
    "--directory",
    "skill",
  ]);
  expect(initialized.code, initialized.stderr).toBe(0);
  const sample = join(root, "skill");
  const args = ["run", "--run-manifest-file", "run.json", "--json", "--dry"];
  const missing = await run(sample, args);
  expect(missing.code).toBe(64);
  expect(missing.stderr).toContain("--codex-auth-file");
  await writeFile(join(sample, "auth.json"), "synthetic preparation only");
  const prepared = await run(sample, [
    ...args,
    "--model",
    "synthetic",
    "--effort",
    "low",
    "--codex-bin",
    "/bin/true",
    "--codex-auth-file",
    "auth.json",
  ]);
  expect(prepared.code, prepared.stderr).toBe(0);
  const result = parseCliResult(prepared.stdout);
  expect(result).toMatchObject({
    execution: { status: "not_run" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
  });
  const evidence = parseRunEvidence(
    await readFile(defined(result.evidencePath), "utf8"),
  );
  expect(
    evidence.trials[0]?.artifactRefs.some(
      (artifact) => artifact.id === "template.startup-skill",
    ),
  ).toBe(true);
  expect(
    await readFile(
      join(sample, ".agents/skills/startup-guide/SKILL.md"),
      "utf8",
    ),
  ).toContain("README.md");
  expect(await readFile(join(sample, "README.md"), "utf8")).toContain(
    "No authenticated model execution",
  );
});

test("progress follows actual candidate execution on stderr while JSON stays one document", async () => {
  const root = await directory();
  await run(root, ["init", "--directory", "progress"]);
  const sample = join(root, "progress");
  await writeFile(
    join(sample, "adapter.ts"),
    'export default { id: "test.progress", model: "fixture", effort: "none", run() { process.stderr.write("candidate called\\n"); return Promise.resolve({ finalMessage: "ready", complete: true }); } };\n',
  );
  const args = ["run", "--json", "--run-manifest-file", "run.json"];
  const executed = await run(sample, args);
  expect(executed.code, executed.stderr).toBe(0);
  expect(parseCliResult(executed.stdout).task.verdict).toBe("passed");
  expect(executed.stderr).toContain("sevro: preparation started");
  expect(
    executed.stderr.indexOf("sevro: candidate started trial=1"),
  ).toBeLessThan(executed.stderr.indexOf("candidate called"));
  expect(
    executed.stderr.indexOf("sevro: grading started trial=1"),
  ).toBeGreaterThan(executed.stderr.indexOf("candidate called"));
  expect(executed.stderr).toContain("sevro: evidence completed");
  const dry = await run(sample, [...args, "--dry"]);
  expect(dry.code, dry.stderr).toBe(0);
  expect(dry.stderr).not.toContain("candidate called");
  expect(dry.stderr).not.toContain("candidate started");
  expect(dry.stderr).toContain("candidate skipped trial=1");
  expect(dry.stderr).toContain("grading skipped trial=1");
  expect(parseCliResult(dry.stdout).task.verdict).toBe("not_assessed");
});

test("completion shows trial failures and measured duration and latest supports relative paths", async () => {
  const root = await directory();
  await run(root, ["init", "--directory", "summary"]);
  const sample = join(root, "summary");
  const args = ["run", "--run-manifest-file", "run.json"];
  const completed = await run(sample, args, { SEVRO_TEMPLATE_FAIL: "1" });
  expect(completed.code, completed.stderr).toBe(1);
  expect(completed.stdout).toContain(
    "trial case=response-check trial=1 execution=completed grading=completed task=failed",
  );
  expect(completed.stdout).toContain("check=ready status=failed reason=");
  expect(completed.stdout).toMatch(/candidate duration=\d+\.\d{2}ms/);
  expect(completed.stdout).toContain(
    "candidate tokens=unknown/unknown cost=unknown",
  );
  const latest = await run(sample, ["report", "--latest", "--json"]);
  expect(latest.code, latest.stderr).toBe(0);
  const report: unknown = JSON.parse(latest.stdout);
  expect(report).toMatchObject({
    format: "sevro.report.v1",
    rows: [{ task: "failed" }],
  });
  const relative = await run(sample, [
    "report",
    "--result-file",
    ".sevro/results/latest.json",
  ]);
  expect(relative.code, relative.stderr).toBe(0);
  expect(relative.stdout).toContain("failed");
  const dry = await run(sample, [...args, "--dry"]);
  expect(dry.code, dry.stderr).toBe(0);
  expect(dry.stdout).toContain("candidate duration=unknown");
  expect(dry.stdout).toContain("task=not_assessed");
  const latestDry = await run(sample, ["report", "--latest"]);
  expect(latestDry.code, latestDry.stderr).toBe(0);
  expect(latestDry.stdout).toContain("unknown");
  expect(latestDry.stdout).toContain("not_assessed");
});

test("latest publication replaces a symlink without touching its target and preserves failure precedence", async () => {
  const root = await directory();
  await run(root, ["init", "--directory", "latest"]);
  const sample = join(root, "latest");
  const results = join(sample, ".sevro/results");
  await mkdir(results, { recursive: true });
  const target = join(root, "keep.txt");
  await writeFile(target, "original user content");
  await symlink(target, join(results, "latest.json"));
  const args = ["run", "--json", "--run-manifest-file", "run.json"];
  const passed = await run(sample, args);
  expect(passed.code, passed.stderr).toBe(0);
  expect(await readFile(target, "utf8")).toBe("original user content");
  expect(await realpath(join(results, "latest.json"))).toBe(
    join(results, "latest.json"),
  );
  await rm(join(results, "latest.json"));
  await mkdir(join(results, "latest.json"));
  const failed = await run(sample, args, { SEVRO_TEMPLATE_FAIL: "1" });
  expect(failed.code, failed.stderr).toBe(1);
  expect(parseCliResult(failed.stdout).task.verdict).toBe("failed");
  expect(failed.stderr).toContain("original run outcome preserved");
  const unavailable = await run(sample, args);
  expect(unavailable.code, unavailable.stderr).toBe(70);
  expect(parseCliResult(unavailable.stdout).task.verdict).toBe("not_assessed");
  expect(unavailable.stderr).toContain(
    "CLI result/latest could not be retained",
  );
});

test("throwing progress observers cannot change assessment or retained evidence", async () => {
  const root = await directory();
  let observations = 0;
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "results"),
    case: baseline,
    host: {
      id: "test.progress",
      model: "fixture",
      effort: "none",
      run: () => Promise.resolve({ finalMessage: "ready", complete: true }),
    },
    onProgress() {
      observations++;
      throw new Error("observer failure");
    },
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(observations).toBeGreaterThan(0);
  expect(result.task.verdict).toBe("passed");
  expectUnknown(
    parseRunEvidence(await readFile(result.evidencePath, "utf8")).result,
  ).toEqual(result);
});

test("repository skill template assertions accept the fixture answer and reject a wrong port with a synthetic receipt", async () => {
  const root = await directory();
  await run(root, [
    "init",
    "--template",
    "repository-skill",
    "--directory",
    "skill-checks",
  ]);
  const sample = join(root, "skill-checks");
  // This trusted protocol fixture proves the template's checks, not native dispatch.
  await writeFile(
    join(sample, "synthetic.ts"),
    `export default {
    id: "test.repository-skill", model: "synthetic", effort: "none",
    hostCapabilities: ["sevro.codex.repository-invocation"],
    run() { return Promise.resolve({ finalMessage: process.env.SEVRO_TEMPLATE_FAIL === "1" ? "Run bun run dev on port 9000." : "Run bun run dev on port 3000.", complete: true,
      observations: [{ id: "sevro.codex.explicit-invocation", completeness: "complete", data: { synthetic: true } }] }); }
  };\n`,
  );
  const args = [
    "run",
    "--json",
    "--run-manifest-file",
    "run.json",
    "--adapter-module",
    "synthetic.ts",
  ];
  const passed = await run(sample, args);
  expect(passed.code, passed.stderr).toBe(0);
  expect(parseCliResult(passed.stdout).task.verdict).toBe("passed");
  const failed = await run(sample, args, { SEVRO_TEMPLATE_FAIL: "1" });
  expect(failed.code, failed.stderr).toBe(1);
  expect(
    parseCliResult(failed.stdout).cases[0]?.trials[0]?.checks,
  ).toMatchObject([
    { id: "start-command", status: "passed" },
    { id: "port", status: "failed" },
  ]);
});

test("failed execution skips grading and keeps private prompts and response bodies out of human summaries", async () => {
  const root = await directory();
  await run(root, ["init", "--directory", "failure"]);
  const sample = join(root, "failure");
  const definition = { ...baseline, prompt: "PRIVATE_PROMPT_DO_NOT_PRINT" };
  await writeFile(join(sample, "case.json"), JSON.stringify(definition));
  await writeFile(
    join(sample, "adapter.ts"),
    'export default { id: "test.failure", model: "fixture", effort: "none", run() { throw new Error("PRIVATE_NATIVE_BODY_DO_NOT_PRINT"); } };\n',
  );
  const failed = await run(sample, ["run", "--run-manifest-file", "run.json"]);
  expect(failed.code, failed.stderr).toBe(2);
  expect(failed.stderr).toContain("grading skipped trial=1");
  expect(failed.stderr).not.toContain("grading started");
  expect(failed.stdout).toContain(
    "execution=failed grading=not_requested task=not_assessed",
  );
  expect(failed.stdout + failed.stderr).not.toContain(
    "PRIVATE_PROMPT_DO_NOT_PRINT",
  );
  expect(failed.stdout + failed.stderr).not.toContain(
    "PRIVATE_NATIVE_BODY_DO_NOT_PRINT",
  );
});

test("completion displays known zero usage and cost separately from unknown measurements", async () => {
  const root = await directory();
  await run(root, ["init", "--directory", "measured"]);
  const sample = join(root, "measured");
  await writeFile(
    join(sample, "adapter.ts"),
    'export default { id: "test.measured", model: "fixture", effort: "none", run() { return Promise.resolve({ finalMessage: "ready", complete: true, inputTokens: 0, outputTokens: 7, costUsd: 0, usageComplete: true }); } };\n',
  );
  const completed = await run(sample, [
    "run",
    "--run-manifest-file",
    "run.json",
  ]);
  expect(completed.code, completed.stderr).toBe(0);
  expect(completed.stdout).toContain("candidate tokens=0/7 cost=$0.0000");
  expect(completed.stdout).toMatch(/candidate duration=\d+\.\d{2}ms/);
  const report = await run(sample, ["report", "--latest", "--json"]);
  expect(report.code, report.stderr).toBe(0);
  expect(JSON.parse(report.stdout) as unknown).toMatchObject({
    rows: [{ inputTokens: 0, outputTokens: 7, costUsd: 0 }],
  });
});

test("init refuses directory aliases without touching user content and report detects canonical duplicate inputs", async () => {
  const root = await directory();
  await mkdir(join(root, "existing"));
  await writeFile(join(root, "existing/keep.txt"), "preserve");
  await symlink("existing", join(root, "alias"));
  const refused = await run(root, ["init", "--directory", "alias"]);
  expect(refused.code).toBe(64);
  expect(await readFile(join(root, "existing/keep.txt"), "utf8")).toBe(
    "preserve",
  );
  await run(root, ["init", "--directory", "distinct"]);
  const sample = join(root, "distinct");
  await run(sample, ["run", "--run-manifest-file", "run.json", "--json"]);
  const duplicate = await run(sample, [
    "report",
    "--result-file",
    ".sevro/results/latest.json",
    "--result-file",
    "./.sevro/results/latest.json",
  ]);
  expect(duplicate.code).toBe(64);
  expect(duplicate.stderr).toContain("distinct result files");
  const relocated = await run(root, [
    "report",
    "--latest",
    "--results-root",
    "distinct/.sevro/results",
    "--json",
  ]);
  expect(relocated.code, relocated.stderr).toBe(0);
  expect(JSON.parse(relocated.stdout) as unknown).toMatchObject({
    rows: [{ task: "passed" }],
  });
});

test.each(
  [
    ["init", "--template", "unknown"],
    ["init", "unexpected"],
    ["init", "--directory", ""],
    ["report", "--latest", "--result-file", "result.json"],
    ["report", "--results-root", "elsewhere"],
    ["report", "--result-file", ""],
  ].map((args) => ({ args })),
)("workflow refuses ambiguous or empty input %j", async ({ args }) => {
  const result = await run(await directory(), args);
  expect(result.code).toBe(64);
  expect(result.stderr).not.toBe("");
  expect(result.stdout).toBe("");
});
