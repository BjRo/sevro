import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assertCliResult } from "../src/schema";

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `Node shell check did not start: ${path}`);
    await sleep(20);
  }
}

function running(pid: number): boolean {
  const status = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "stat="]);
  return (
    status.exitCode === 0 && !status.stdout.toString().trim().startsWith("Z")
  );
}

async function requireStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (running(pid) && Date.now() < deadline) await sleep(20);
  assert.equal(
    running(pid),
    false,
    "Node interruption left its shell child running",
  );
}

async function fixture(root: string) {
  const project = join(root, "interruption-project");
  await mkdir(project);
  const workspaceFile = join(root, "interruption-workspace.txt");
  const adapter = join(root, "interruption-adapter.mjs");
  await writeFile(
    adapter,
    `import { writeFile } from "node:fs/promises";
export default { id: "synthetic", model: "synthetic", effort: "none", async run({ workspace }) {
  await writeFile(${JSON.stringify(workspaceFile)}, workspace);
  return { finalMessage: "ready", complete: true };
} };\n`,
  );
  const caseFile = join(root, "interruption-case.json");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "node-interruption",
      prompt: "Return ready",
      fixture: { files: { "README.md": "fixture" } },
      requiredEvidence: [],
      checks: [
        {
          id: "owned-child",
          grader: "sevro.shell",
          configuration: {
            run: "/bin/sleep 60 & child=$!; printf '%s' \"$child\" > shell-child.pid; wait",
            timeoutMs: 30_000,
          },
        },
      ],
    }),
  );
  return { project, workspaceFile, adapter, caseFile };
}

/** Interrupt a real Node CLI shell check and verify retained output and child cleanup. */
export async function verifyNodeInterruption(
  cli: string,
  root: string,
  env: NodeJS.ProcessEnv,
) {
  const files = await fixture(root);
  const child = Bun.spawn(
    [
      cli,
      "run",
      "--json",
      "--case-file",
      files.caseFile,
      "--adapter-module",
      files.adapter,
      "--project-root",
      files.project,
      "--results-root",
      join(root, "interruption-results"),
      "--protected-root",
      root,
      "--shell-isolation",
      "--jobs",
      "1",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const output = new Response(child.stdout).text();
  const diagnostic = new Response(child.stderr).text();
  try {
    await waitFor(files.workspaceFile);
    const workspace = await readFile(files.workspaceFile, "utf8");
    const ready = join(workspace, "shell-child.pid");
    await waitFor(ready);
    const pid = Number(await readFile(ready, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    child.kill("SIGTERM");
    const [stdout, stderr, code] = await Promise.all([
      output,
      diagnostic,
      child.exited,
    ]);
    assert.equal(code, 143, stderr);
    const result: unknown = JSON.parse(stdout);
    assertCliResult(result);
    assert.equal(result.exitCode, 143);
    assert.notEqual(result.task.verdict, "passed");
    assert.ok(result.evidencePath && existsSync(result.evidencePath));
    await requireStopped(pid);
  } catch (cause) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error(await diagnostic, { cause });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}
