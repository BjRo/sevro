import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyNodeInterruption } from "./node-runtime-interruption";

const source = resolve(import.meta.dirname, "..");

async function command(argv: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function verifyExtensionLaunchFailure(
  cli: string,
  root: string,
  packageRoot: string,
  env: NodeJS.ProcessEnv,
) {
  const project = join(root, "unlaunchable-extension");
  await mkdir(project);
  const executable = join(project, "extension.sh");
  const commandFile = join(project, "command.json");
  // Readable provenance inputs can still lack executable permissions.
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  await writeFile(commandFile, JSON.stringify([executable]));
  const failed = await command(
    [
      cli,
      "run",
      "--adapter-module",
      join(packageRoot, "dist/examples/basic/host.js"),
      "--extension-command-file",
      commandFile,
      "--extension-source-file",
      executable,
      "--case-id",
      "unlaunchable",
      "--project-root",
      project,
      "--results-root",
      join(root, "launch-failure-results"),
      "--json",
    ],
    project,
    env,
  );
  assert.equal(failed.code, 70, failed.stderr);
  const result = JSON.parse(failed.stdout) as {
    execution: { status: string };
    task: { verdict: string };
    diagnostic: { code: string; message: string };
  };
  assert.equal(result.execution.status, "not_run");
  assert.equal(result.task.verdict, "not_assessed");
  assert.equal(result.diagnostic.code, "sevro.runner.error");
  assert.match(result.diagnostic.message, /could not start extension process/);
  assert.doesNotMatch(failed.stderr, /Unhandled 'error' event/);
}

const root = await mkdtemp(join(tmpdir(), "sevro-node-package-"));
try {
  const packed = await command(
    ["npm", "pack", "--silent", "--pack-destination", root],
    source,
  );
  assert.equal(packed.code, 0, packed.stderr);
  const consumer = join(root, "consumer");
  const bin = join(root, "tools");
  await Promise.all([mkdir(consumer), mkdir(bin)]);
  const node = Bun.which("node");
  assert.ok(node, "Node 24 is required for package acceptance");
  await symlink(node, join(bin, "node"));
  const installed = await command(
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(root, packed.stdout.trim()),
    ],
    consumer,
  );
  assert.equal(installed.code, 0, installed.stderr);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` };
  assert.equal(Bun.which("bun", { PATH: env.PATH }), null);
  const cli = join(consumer, "node_modules/.bin/sevro");
  const help = await command([cli, "--help"], consumer, env);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Usage: sevro/);
  const demo = await command([cli, "demo", "--json"], consumer, env);
  assert.equal(demo.code, 0, demo.stderr);
  const result = JSON.parse(demo.stdout) as { task: { verdict: string } };
  assert.equal(result.task.verdict, "passed");
  const project = join(root, "repository-skill");
  const initialized = await command(
    [cli, "init", "--template", "repository-skill", "--directory", project],
    consumer,
    env,
  );
  assert.equal(initialized.code, 0, initialized.stderr);
  const prepared = await command(
    [
      cli,
      "run",
      "--run-manifest-file",
      "run.json",
      "--model",
      "synthetic",
      "--effort",
      "low",
      "--codex-bin",
      "/bin/false",
      "--codex-auth-file",
      "/unused-auth.json",
      "--dry",
      "--json",
    ],
    project,
    env,
  );
  assert.equal(prepared.code, 0, prepared.stderr);
  const dry = JSON.parse(prepared.stdout) as {
    task: { verdict: string };
    execution: { status: string };
  };
  assert.equal(dry.task.verdict, "not_assessed");
  assert.equal(dry.execution.status, "not_run");
  const packageRoot = join(consumer, "node_modules/@bjoernrochel/sevro");
  const recipes = join(root, "recipes");
  await cp(join(packageRoot, "dist/examples/recipes"), recipes, {
    recursive: true,
  });
  for (const name of ["lifecycle", "coding-change"]) {
    const recipe = await command(
      [node, join(recipes, "run.js"), name, "deterministic"],
      consumer,
      {
        ...env,
        SEVRO_RECIPE_CLI: join(packageRoot, "dist/src/cli.js"),
      },
    );
    assert.equal(recipe.code, 0, recipe.stderr);
    const assessed = JSON.parse(recipe.stdout) as { task: { verdict: string } };
    assert.equal(assessed.task.verdict, "passed");
  }
  const workflows = await command(
    [
      process.execPath,
      join(source, "scripts/verify-package-install.ts"),
      "--tarball",
      join(root, packed.stdout.trim()),
    ],
    consumer,
    { ...env, SEVRO_INSTALLED_RUNTIME: node },
  );
  assert.equal(workflows.code, 0, workflows.stderr);
  await verifyExtensionLaunchFailure(cli, root, packageRoot, env);
  await verifyNodeInterruption(cli, root, env);
  console.log(
    "Installed Node CLI: help and assessed demo passed with Bun absent from PATH",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
