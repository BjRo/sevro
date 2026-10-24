import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertCliResult,
  assertReport,
  assertRunEvidence,
} from "../src/schema";

async function invoke(
  command: string,
  cwd: string,
  args: string[],
  expected = 0,
  environment: NodeJS.ProcessEnv = {},
) {
  const child = Bun.spawn(
    [process.env.SEVRO_INSTALLED_RUNTIME ?? process.execPath, command, ...args],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...environment },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, expected, `${args.join(" ")}: ${stderr}`);
  return stdout;
}

async function assessedTemplate(
  command: string,
  root: string,
  template: string,
) {
  await invoke(command, root, [
    "init",
    "--template",
    template,
    "--directory",
    template,
  ]);
  const cwd = join(root, template);
  for (const [mode, expected, verdict] of [
    ["pass", 0, "passed"],
    ["fail", 1, "failed"],
    ["dry", 0, "not_assessed"],
  ] as const) {
    await verifyTemplateRun(command, cwd, { mode, expected, verdict });
  }
  const report: unknown = JSON.parse(
    await invoke(command, cwd, ["report", "--latest", "--json"]),
  );
  assertReport(report);
  assert.ok(report.rows[0]);
  assert.equal(report.rows[0].task, "not_assessed");
  assert.equal(report.rows[0].candidateDurationMs, null);
}

async function verifyTemplateRun(
  command: string,
  cwd: string,
  control: { mode: string; expected: number; verdict: string },
) {
  const args = ["run", "--json", "--run-manifest-file", "run.json"];
  if (control.mode === "dry") args.push("--dry");
  const value: unknown = JSON.parse(
    await invoke(command, cwd, args, control.expected, {
      SEVRO_TEMPLATE_FAIL: control.mode === "fail" ? "1" : "0",
    }),
  );
  assertCliResult(value);
  assert.equal(value.task.verdict, control.verdict);
  assert.ok(value.evidencePath);
  const evidence: unknown = JSON.parse(
    await readFile(value.evidencePath, "utf8"),
  );
  assertRunEvidence(evidence);
  assert.deepEqual(evidence.result, value);
  assert.ok(evidence.trials[0]);
  assert.equal(
    evidence.trials[0].candidateDurationMs === null,
    control.mode === "dry",
  );
}

async function nativeTemplate(command: string, root: string) {
  await invoke(command, root, [
    "init",
    "--template",
    "repository-skill",
    "--directory",
    "repository-skill",
  ]);
  const cwd = join(root, "repository-skill");
  await writeFile(
    join(cwd, "preparation-auth.json"),
    "synthetic preparation only\n",
  );
  const value: unknown = JSON.parse(
    await invoke(command, cwd, [
      "run",
      "--json",
      "--run-manifest-file",
      "run.json",
      "--dry",
      "--codex-bin",
      "/bin/true",
      "--codex-auth-file",
      "preparation-auth.json",
      "--model",
      "synthetic",
      "--effort",
      "low",
    ]),
  );
  assertCliResult(value);
  assert.equal(value.execution.status, "not_run");
  assert.equal(value.task.verdict, "not_assessed");
  assert.ok(value.evidencePath);
  const evidence: unknown = JSON.parse(
    await readFile(value.evidencePath, "utf8"),
  );
  assertRunEvidence(evidence);
  assert.ok(
    evidence.trials[0]?.artifactRefs.some(
      (item) => item.id === "template.startup-skill",
    ),
  );
}

export async function verifyPackageWorkflow(
  command: string,
  root: string,
): Promise<void> {
  await invoke(command, root, ["demo", "--json"]);
  for (const template of ["response", "coding"])
    await assessedTemplate(command, root, template);
  await nativeTemplate(command, root);
  console.log(
    "Passed installed candidate demo/init/prepare/execute/latest: response and coding pass/fail, native skill dry only; no authenticated model execution.",
  );
}
