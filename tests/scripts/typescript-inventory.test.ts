import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { copySnapshot } from "../../scripts/coverage/prepare";
import { object } from "../../scripts/coverage/records";
import { createTemporaryFixtures, fixtureGit } from "../fixtures/filesystem";

const repo = resolve(import.meta.dir, "../..");
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

function writeSource(root: string, file: string, content = "export {};\n") {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function publicInventory(root: string, env = process.env) {
  const child = Bun.spawnSync(
    [
      process.execPath,
      join(repo, "scripts/check-typescript.ts"),
      "--inventory",
      root,
    ],
    { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

function observedInventory(stdout: string): unknown {
  return JSON.parse(stdout);
}

test("public inventory derives new source roles without a manifest and classifies declarations once", async () => {
  const { project } = copySnapshot(repo, await temporaryFixture());
  expect(existsSync(join(project, "typescript-sources.json"))).toBe(false);
  for (const file of [
    "src/added with spaces.ts",
    "tests/new.test.ts",
    "tests/new.d.ts",
    "scripts/new.ts",
    "examples/new.ts",
  ])
    writeSource(project, file);
  const result = publicInventory(project);
  expect(result.code, result.stderr).toBe(0);
  const inventory = object(observedInventory(result.stdout));
  expect(inventory.production).toContain("src/added with spaces.ts");
  expect(inventory.tests).toContain("tests/new.test.ts");
  expect(inventory.declarations).toContain("tests/new.d.ts");
  expect(inventory.tooling).toContain("scripts/new.ts");
  expect(inventory.examples).toContain("examples/new.ts");
  expect(result.stdout.match(/"tests\/new\.d\.ts"/g)).toHaveLength(1);
}, 30000);

test("public inventory and independent snapshots preserve staged renames, deletions and untracked additions", async () => {
  const { project } = copySnapshot(repo, await temporaryFixture());
  await fixtureGit(
    project,
    "mv",
    "src/value-guards.ts",
    "src/renamed-guards.ts",
  );
  await fixtureGit(project, "rm", "tests/src/value-guards.test.ts");
  writeSource(project, "src/new-candidate.ts");
  appendFileSync(join(project, ".gitignore"), "\nsrc/force-added.ts\n");
  writeSource(project, "src/force-added.ts");
  await fixtureGit(project, "add", "--force", "src/force-added.ts");
  const snapshot = copySnapshot(project, await temporaryFixture());
  for (const root of [project, snapshot.project]) {
    const result = publicInventory(root);
    expect(result.code, result.stderr).toBe(0);
    const inventory = object(observedInventory(result.stdout));
    expect(inventory.production).toContain("src/renamed-guards.ts");
    expect(inventory.production).toContain("src/new-candidate.ts");
    expect(inventory.production).toContain("src/force-added.ts");
    expect(result.stdout).not.toContain('"src/value-guards.ts"');
    expect(result.stdout).not.toContain('"tests/src/value-guards.test.ts"');
  }
  expect(await fixtureGit(project, "ls-files", "src/new-candidate.ts")).toBe(
    "",
  );
  expect(
    await fixtureGit(snapshot.project, "ls-files", "src/new-candidate.ts"),
  ).toBe("src/new-candidate.ts");
}, 30000);

test("public inventory refuses ignored authored sources instead of omitting them", async () => {
  const { project } = copySnapshot(repo, await temporaryFixture());
  writeSource(
    project,
    ".gitignore",
    "node_modules/\n.quality/\nsrc/ignored.ts\n",
  );
  writeSource(project, "src/ignored.ts");
  const result = publicInventory(project);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unregistered source: src/ignored.ts");
});

test("public inventory refuses a staged deletion from the exact generated-validator set", async () => {
  const { project } = copySnapshot(repo, await temporaryFixture());
  await fixtureGit(project, "rm", "src/generated/extension.cjs");
  const result = publicInventory(project);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "Expected the five exact generated validators",
  );
});

test("public inventory ignores ambient Git repository and configuration selectors", async () => {
  const { project } = copySnapshot(repo, await temporaryFixture());
  const ordinary = publicInventory(project);
  expect(ordinary.code, ordinary.stderr).toBe(0);
  const redirected = publicInventory(project, {
    ...process.env,
    GIT_DIR: join(await temporaryFixture(), "missing.git"),
    GIT_WORK_TREE: repo,
    GIT_INDEX_FILE: join(repo, ".quality/missing-inventory-index"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: repo,
  });
  expect(redirected.code, redirected.stderr).toBe(0);
  expect(redirected.stdout).toBe(ordinary.stdout);
}, 30000);

test("public inventory requires its own repository root", async () => {
  const { project } = copySnapshot(repo, await temporaryFixture());
  const nested = publicInventory(join(project, "tests"));
  expect(nested.code).toBe(1);
  expect(nested.stderr).toContain(
    "Source inventory root must be the Git repository root",
  );
  const absent = publicInventory(await temporaryFixture());
  expect(absent.code).toBe(1);
  expect(absent.stderr).toContain("Cannot read source inventory from Git");
});
