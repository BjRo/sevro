import { afterEach, test, expect } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBlindAdvisoryFixture } from "../src/advisory-fixture";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function git(workspace: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@sevro.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@sevro.invalid",
    },
  });
  const [out, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return out.trim();
}
test("advisory fixture shows the full candidate change without condition files or source history", async () => {
  const source = await mkdtemp(join(tmpdir(), "sevro-advisory-source-"));
  roots.push(source);
  await git(source, "init", "--initial-branch=main");
  await writeFile(join(source, "app.ts"), "export const value = 1;\n");
  await writeFile(join(source, "remove.txt"), "obsolete\n");
  await mkdir(join(source, ".agents"));
  await writeFile(
    join(source, ".agents", "condition.txt"),
    "secret condition\n",
  );
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "base fixture");
  const baseRevision = await git(source, "rev-parse", "HEAD");
  await writeFile(join(source, "app.ts"), "export const value = 2;\n");
  await writeFile(
    join(source, ".agents", "condition.txt"),
    "modified secret\n",
  );
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "candidate commit");
  await writeFile(join(source, "app.ts"), "export const value = 3;\n");
  await rm(join(source, "remove.txt"));
  await writeFile(join(source, "new-test.ts"), "test('value', () => {});\n");
  await mkdir(join(source, ".claude"));
  await writeFile(join(source, ".claude", "instructions.md"), "secret\n");
  await writeFile(join(source, "private.txt"), "hidden\n");
  const view = await buildBlindAdvisoryFixture(source, {
    baseRevision,
    excludedPaths: ["private.txt"],
  });
  roots.push(view);
  expect(await readFile(join(view, "app.ts"), "utf8")).toBe(
    "export const value = 3;\n",
  );
  expect(await readFile(join(view, "new-test.ts"), "utf8")).toContain("test(");
  expect(await Bun.file(join(view, "remove.txt")).exists()).toBeFalse();
  for (const hidden of [".agents", ".claude", ".codex", "private.txt"])
    expect(await Bun.file(join(view, hidden)).exists()).toBeFalse();
  expect(await git(view, "log", "--format=%s")).toBe("Advisory baseline");
  expect(await git(view, "remote")).toBe("");
  const diff = await git(view, "diff", "--", "app.ts", "remove.txt");
  expect(diff).toContain("+export const value = 3;");
  expect(diff).toContain("-obsolete");
  expect(diff).not.toContain("secret condition");
});
test("advisory fixture rejects escaping untracked symlinks", async () => {
  if (process.platform === "win32") return;
  const source = await mkdtemp(join(tmpdir(), "sevro-advisory-symlink-"));
  roots.push(source);
  await git(source, "init", "--initial-branch=main");
  await writeFile(join(source, "app.ts"), "base\n");
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "base fixture");
  const baseRevision = await git(source, "rev-parse", "HEAD");
  await symlink("../../outside", join(source, "escape"));
  expect(buildBlindAdvisoryFixture(source, { baseRevision })).rejects.toThrow(
    /escaping symlink/,
  );
  expect((await lstat(join(source, "escape"))).isSymbolicLink()).toBeTrue();
});
test("advisory fixture rejects a tracked symlink chain that escapes", async () => {
  if (process.platform === "win32") return;
  const source = await mkdtemp(join(tmpdir(), "sevro-advisory-chain-"));
  roots.push(source);
  await git(source, "init", "--initial-branch=main");
  await symlink("../../outside", join(source, "escape"));
  await symlink("escape", join(source, "indirect"));
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "base fixture");
  const baseRevision = await git(source, "rev-parse", "HEAD");
  expect(buildBlindAdvisoryFixture(source, { baseRevision })).rejects.toThrow(
    /symlink/,
  );
});
