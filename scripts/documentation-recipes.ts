import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertCliResult, assertRunEvidence } from "../src/schema";
import type { CliResultData } from "../src/schema-types";
import { shellExample } from "./documentation-example-results";

const deterministic = [
  "coding-change",
  "host-tools",
  "node",
  "python-uv",
  "mise",
  "semantic",
  "lifecycle",
];

function requireAssessment(
  result: CliResultData,
  mode: string,
  code: number,
): void {
  const expected: Record<string, (string | number)[]> = {
    pass: [0, 0, "completed", "completed", "passed"],
    fail: [1, 1, "completed", "completed", "failed"],
    dry: [0, 0, "not_run", "not_requested", "not_assessed"],
  };
  assert.deepEqual(
    [
      code,
      result.exitCode,
      result.execution.status,
      result.grading.status,
      result.task.verdict,
    ],
    expected[mode],
    `Unexpected recipe assessment: ${JSON.stringify(result)}`,
  );
}

async function requireEvidence(
  result: CliResultData,
  cwd: string,
): Promise<void> {
  const path = result.evidencePath;
  assert.ok(path, "Recipe did not retain evidence");
  assert.ok(
    path.startsWith(join(cwd, ".sevro-recipes") + "/"),
    "Recipe evidence escaped its output root",
  );
  const evidence: unknown = JSON.parse(await readFile(path, "utf8"));
  assertRunEvidence(evidence);
  assert.equal(evidence.result.task.verdict, result.task.verdict);
  assert.equal(evidence.trials.length, 1);
  for (const trial of evidence.trials) {
    for (const artifact of trial.artifactRefs) {
      const bytes = await readFile(new URL(artifact.path));
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        artifact.sha256,
        "Prepared recipe artifact differs from its verified bytes",
      );
    }
  }
}

async function verifyCommand(
  command: string,
  mode: string,
  cwd: string,
  installed: string,
): Promise<void> {
  const child = Bun.spawn(["/bin/sh", "-eu", "-c", command], {
    cwd,
    env: {
      ...process.env,
      SEVRO_RECIPES: join(cwd, "recipes"),
      SEVRO_RECIPE_CLI: join(installed, "dist/src/cli.js"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, diagnostic, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let result: unknown;
  try {
    result = JSON.parse(output);
  } catch (cause) {
    throw new Error(`Recipe produced no result: ${command}\n${diagnostic}`, {
      cause,
    });
  }
  assertCliResult(result);
  requireAssessment(result, mode, code);
  await requireEvidence(result, cwd);
}

async function verifyDeterministic(
  text: string,
  cwd: string,
  installed: string,
): Promise<void> {
  for (const recipe of deterministic) {
    for (const mode of ["pass", "fail"]) {
      await verifyCommand(
        shellExample(text, `recipe-${recipe}-${mode}`),
        mode,
        cwd,
        installed,
      );
    }
    for (const host of ["codex", "claude"]) {
      const command = shellExample(text, `recipe-${recipe}-pass`).replace(
        " deterministic",
        ` ${host} --dry`,
      );
      await verifyCommand(command, "dry", cwd, installed);
    }
    console.log(
      `Passed recipe ${recipe}: real deterministic pass/fail and both native dry preparations`,
    );
  }
}

async function verifyNative(
  text: string,
  cwd: string,
  installed: string,
): Promise<void> {
  for (const recipe of ["repository-skill", "plugins"]) {
    for (const host of ["codex", "claude"]) {
      const command = shellExample(text, `recipe-${recipe}-${host}-dry`);
      await verifyCommand(command, "dry", cwd, installed);
      await verifyCommand(
        command.replace("--dry", "--dry --fail"),
        "dry",
        cwd,
        installed,
      );
    }
  }
  for (const host of ["codex", "claude"])
    await verifyCommand(
      shellExample(text, `recipe-goals-${host}-dry`),
      "dry",
      cwd,
      installed,
    );
  console.log(
    "Passed repository-skill and plugin/goals/hooks native preparation, including negative-control inputs. Authenticated model/goal/hook trials were not run.",
  );
}

export async function verifyRecipes(
  root: string,
  temporary: string,
  installed: string,
): Promise<void> {
  const cwd = join(temporary, "candidate-recipes");
  await mkdir(cwd);
  await cp(join(installed, "dist/examples/recipes"), join(cwd, "recipes"), {
    recursive: true,
  });
  const text = await readFile(join(root, "docs/recipes.md"), "utf8");
  await verifyDeterministic(text, cwd, installed);
  await verifyNative(text, cwd, installed);
}
