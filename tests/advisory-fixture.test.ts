import { afterEach, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advisoryBaseRevision,
  buildBlindAdvisoryFixture,
} from "../src/advisory-fixture";
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

async function advisoryBoundSource(extraFiles: Record<string, string> = {}) {
  const source = await mkdtemp(join(tmpdir(), "sevro-advisory-bound-"));
  roots.push(source);
  await git(source, "init", "--initial-branch=main");
  await writeFile(join(source, "README.md"), "unchanged baseline\n");
  for (const [path, content] of Object.entries(extraFiles))
    await writeFile(join(source, path), content);
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "Bounded advisory baseline");
  return { source, baseRevision: await git(source, "rev-parse", "HEAD") };
}

async function assertAdvisorySourceUnchanged(
  source: string,
  baseRevision: string,
  status: string,
): Promise<void> {
  expect(await git(source, "rev-parse", "HEAD")).toBe(baseRevision);
  expect(await git(source, "status", "--porcelain=v1")).toBe(status);
  expect(await readFile(join(source, "README.md"), "utf8")).toBe(
    "unchanged baseline\n",
  );
}

function bytesDigest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function advisoryRefusal(
  source: string,
  baseRevision: string,
): Promise<Error> {
  try {
    roots.push(await buildBlindAdvisoryFixture(source, { baseRevision }));
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the bounded advisory fixture to be refused");
}

test.each(["non-Git directory", "unborn repository"])(
  "advisory baseline refuses a %s without changing its contents",
  async (kind) => {
    const source = await mkdtemp(join(tmpdir(), "sevro-advisory-no-head-"));
    roots.push(source);
    await writeFile(join(source, "README.md"), "uncommitted baseline\n");
    if (kind === "unborn repository")
      await git(source, "init", "--initial-branch=main");
    const pending = advisoryBaseRevision(source);
    expect(pending).rejects.toThrow("advisory fixture Git operation failed");
    await pending.catch(() => undefined);
    expect(await readFile(join(source, "README.md"), "utf8")).toBe(
      "uncommitted baseline\n",
    );
    if (kind === "unborn repository")
      expect(await git(source, "status", "--porcelain=v1")).toBe(
        "?? README.md",
      );
  },
);

test("advisory fixture refuses an unavailable immutable baseline and preserves the candidate change", async () => {
  const { source, baseRevision } = await advisoryBoundSource();
  await writeFile(join(source, "candidate.txt"), "candidate change\n");
  const status = await git(source, "status", "--porcelain=v1");
  const error = await advisoryRefusal(source, "0".repeat(40));
  expect(error.message).toBe("advisory fixture Git operation failed");
  await assertAdvisorySourceUnchanged(source, baseRevision, status);
  expect(await readFile(join(source, "candidate.txt"), "utf8")).toBe(
    "candidate change\n",
  );
});

test.each([".git", ".GIT", ".git/HEAD", ".GiT/config"])(
  "advisory exclusions refuse reserved metadata path %s before copying source",
  async (path) => {
    const { source, baseRevision } = await advisoryBoundSource();
    const pending = buildBlindAdvisoryFixture(source, {
      baseRevision,
      excludedPaths: [path],
    });
    expect(pending).rejects.toThrow("invalid advisory exclusion");
    await pending.catch(() => undefined);
    await assertAdvisorySourceUnchanged(source, baseRevision, "");
  },
);

test("advisory fixture refuses more than 1024 untracked files without changing source inputs", async () => {
  const { source, baseRevision } = await advisoryBoundSource();
  const directory = join(source, "untracked");
  await mkdir(directory);
  const names = Array.from(
    { length: 1025 },
    (_, index) => `change-${index}.txt`,
  );
  for (const name of names)
    await writeFile(join(directory, name), "candidate file\n");
  const status = await git(source, "status", "--porcelain=v1");
  const error = await advisoryRefusal(source, baseRevision);
  expect(error.message).toBe("advisory fixture has too many untracked files");
  await assertAdvisorySourceUnchanged(source, baseRevision, status);
  expect((await readdir(directory)).sort()).toEqual([...names].sort());
  for (const name of names)
    expect(await readFile(join(directory, name), "utf8")).toBe(
      "candidate file\n",
    );
});

test("advisory fixture refuses untracked bytes above 32 MiB without changing source inputs", async () => {
  const { source, baseRevision } = await advisoryBoundSource();
  const path = join(source, "large-untracked.txt");
  const bytes = Buffer.alloc(32 * 1024 * 1024 + 1, "x");
  await writeFile(path, bytes);
  const expectedDigest = bytesDigest(bytes);
  const status = await git(source, "status", "--porcelain=v1");
  const error = await advisoryRefusal(source, baseRevision);
  expect(error.message).toBe(
    "advisory fixture untracked files exceed the size limit",
  );
  await assertAdvisorySourceUnchanged(source, baseRevision, status);
  expect((await lstat(path)).size).toBe(32 * 1024 * 1024 + 1);
  expect(bytesDigest(await readFile(path))).toBe(expectedDigest);
});

test("advisory fixture refuses Git output above 16 MiB with its cause and source inputs intact", async () => {
  const { source, baseRevision } = await advisoryBoundSource({
    "large.txt": "before\n",
  });
  const path = join(source, "large.txt");
  const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, "x");
  bytes[bytes.length - 1] = 10;
  await writeFile(path, bytes);
  const expectedDigest = bytesDigest(bytes);
  const status = await git(source, "status", "--porcelain=v1");
  const patch = await git(source, "diff", "--binary", baseRevision);
  expect(Buffer.byteLength(patch, "utf8")).toBeGreaterThan(16 * 1024 * 1024);
  const error = await advisoryRefusal(source, baseRevision);
  expect(error.message).toBe("advisory fixture Git operation failed");
  expect(error.cause).toBeInstanceOf(Error);
  expect(error.cause).toHaveProperty(
    "message",
    "advisory fixture Git output is too large",
  );
  await assertAdvisorySourceUnchanged(source, baseRevision, status);
  expect(bytesDigest(await readFile(path))).toBe(expectedDigest);
  expect(bytesDigest(await git(source, "diff", "--binary", baseRevision))).toBe(
    bytesDigest(patch),
  );
});

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
