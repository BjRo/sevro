import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

function running(marker: string): boolean {
  // Linux graders have a PID namespace. Observe the owned argv on the host.
  const status = Bun.spawnSync(["/bin/ps", "-axo", "command="]);
  assert.equal(status.exitCode, 0, "could not inspect owned shell processes");
  return status.stdout
    .toString()
    .split("\n")
    .some((command) => command.includes(marker));
}

async function requireStopped(marker: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (running(marker) && Date.now() < deadline) await sleep(20);
  assert.equal(
    running(marker),
    false,
    "Node interruption left its shell child running",
  );
}

async function fixture(root: string) {
  const marker = `sevro-node-owned-${randomUUID()}`;
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
            run: `/bin/bash -c 'exec -a "$0" /bin/sleep 60' ${marker} & printf '%s' ${marker} > shell-child.ready; wait`,
            timeoutMs: 30_000,
          },
        },
      ],
    }),
  );
  return { project, workspaceFile, adapter, caseFile, marker };
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
    const ready = join(workspace, "shell-child.ready");
    await waitFor(ready);
    assert.equal(await readFile(ready, "utf8"), files.marker);
    assert.ok(
      running(files.marker),
      "owned shell process was not observed before interruption",
    );
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
    await requireStopped(files.marker);
  } catch (cause) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error(await diagnostic, { cause });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}
