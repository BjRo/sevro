import { parseRecord } from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  packageBuildDigest,
  projectIdentityDigest,
  projectProvenance,
  runnerProvenance,
} from "../src/provenance";
import { fixtureGit } from "./quality-fixtures/fixture-preparation-tools";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(new TextDecoder().decode(result.stderr));
}

async function snapshotSource() {
  const root = await mkdtemp(join(tmpdir(), "sevro-bounded-provenance-"));
  roots.push(root);
  for (const directory of ["docs", "examples", "schemas", "src"])
    await mkdir(join(root, directory));
  await writeFile(join(root, "README.md"), "unchanged source\n");
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
  return root;
}

const snapshotRoutes = [
  {
    name: "package build",
    snapshot: packageBuildDigest,
    symbolicError: "package build contains a symbolic link",
    sizeError: "package build exceeds the size limit",
  },
  {
    name: "non-Git project",
    snapshot: (root: string) =>
      projectIdentityDigest(root, { revision: null, dirtyPatchDigest: null }),
    symbolicError: "project snapshot contains a symbolic link",
    sizeError: "project snapshot exceeds the size limit",
  },
];

for (const route of snapshotRoutes) {
  test(`${route.name} refuses an owned FIFO without changing its inode or ordinary source files`, async () => {
    const root = await snapshotSource();
    const fifoPath = join(root, "docs", "local.fifo");
    const created = Bun.spawnSync(["/usr/bin/mkfifo", fifoPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(created.exitCode).toBe(0);
    expect(created.stderr.toString()).toBe("");
    const before = await lstat(fifoPath);
    expect(before.isFIFO()).toBe(true);
    const pending = route.snapshot(root);
    expect(pending).rejects.toThrow(
      `${route.name === "package build" ? "package build" : "project snapshot"} contains a non-file`,
    );
    await pending.catch(() => undefined);
    const after = await lstat(fifoPath);
    expect(after.isFIFO()).toBe(true);
    expect(after.ino).toBe(before.ino);
    expect(after.mode).toBe(before.mode);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(
      "unchanged source\n",
    );
  });
}

for (const route of snapshotRoutes) {
  test(`${route.name} refuses symbolic source paths without following or replacing them`, async () => {
    const root = await snapshotSource();
    const link = join(root, "src", "linked.md");
    await symlink("../README.md", link);
    expect(route.snapshot(root)).rejects.toThrow(route.symbolicError);
    expect(await readlink(link)).toBe("../README.md");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(
      "unchanged source\n",
    );
  });

  test(`${route.name} refuses more than 64 MiB of ordinary source bytes without changing them`, async () => {
    const root = await snapshotSource();
    const path = join(root, "docs", "large.txt");
    const bytes = Buffer.alloc(64 * 1024 * 1024 + 1, "x");
    const expected = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path, bytes);
    expect(route.snapshot(root)).rejects.toThrow(route.sizeError);
    expect((await lstat(path)).size).toBe(bytes.length);
    expect(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ).toBe(expected);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(
      "unchanged source\n",
    );
  });
}

async function identityRepository() {
  const root = await mkdtemp(join(tmpdir(), "sevro-dirty-identity-"));
  roots.push(root);
  await fixtureGit(root, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(root, "README.md"), "unchanged source\n");
  await fixtureGit(root, "add", "README.md");
  await fixtureGit(root, "commit", "--quiet", "-m", "Identity baseline");
  return { root, revision: await fixtureGit(root, "rev-parse", "HEAD") };
}

test("Git project provenance refuses tracked patch output above 32 MiB without changing the checkout", async () => {
  const { root, revision } = await identityRepository();
  const bytes = Buffer.alloc(32 * 1024 * 1024 + 1, "x");
  bytes[bytes.length - 1] = 10;
  await writeFile(join(root, "README.md"), bytes);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const status = await fixtureGit(root, "status", "--porcelain=v1");
  expect(projectProvenance(root)).rejects.toThrow(
    "Git identity exceeds the size limit",
  );
  expect(await fixtureGit(root, "rev-parse", "HEAD")).toBe(revision);
  expect(await fixtureGit(root, "status", "--porcelain=v1")).toBe(status);
  expect(
    createHash("sha256")
      .update(await readFile(join(root, "README.md")))
      .digest("hex"),
  ).toBe(expected);
});

test("Git project provenance refuses untracked bytes above 32 MiB without changing the checkout", async () => {
  const { root, revision } = await identityRepository();
  const path = join(root, "large-untracked.txt");
  const bytes = Buffer.alloc(32 * 1024 * 1024 + 1, "x");
  const expected = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path, bytes);
  const status = await fixtureGit(root, "status", "--porcelain=v1");
  expect(projectProvenance(root)).rejects.toThrow(
    "Git identity exceeds the size limit",
  );
  expect(await fixtureGit(root, "rev-parse", "HEAD")).toBe(revision);
  expect(await fixtureGit(root, "status", "--porcelain=v1")).toBe(status);
  expect(
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  ).toBe(expected);
});
test("project provenance stays unknown without a Git revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-no-git-"));
  roots.push(root);
  expect(await projectProvenance(root)).toMatchObject({
    revision: null,
    dirtyPatchDigest: null,
  });
});
test("package build digest tracks packed runtime files without Git metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-package-digest-"));
  roots.push(root);
  for (const directory of ["docs", "examples", "schemas", "src"])
    await mkdir(join(root, directory));
  for (const path of [
    "package.json",
    "README.md",
    "docs/spec.md",
    "examples/basic.json",
    "schemas/evidence.json",
    "src/cli.ts",
  ])
    await writeFile(join(root, path), "original\n");
  const first = await packageBuildDigest(root);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(await packageBuildDigest(root)).toBe(first);
  await writeFile(join(root, "src/cli.ts"), "changed\n");
  const sourceChanged = await packageBuildDigest(root);
  expect(sourceChanged).not.toBe(first);
  await writeFile(join(root, "examples/basic.json"), "changed\n");
  expect(await packageBuildDigest(root)).not.toBe(sourceChanged);
});
test("project identity snapshots non-Git content but excludes result storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-project-digest-"));
  roots.push(root);
  const results = join(root, "results");
  await mkdir(results);
  await writeFile(join(root, "case.json"), "original\n");
  const provenance = await projectProvenance(root);
  const first = await projectIdentityDigest(root, provenance, [results]);
  await writeFile(join(results, "run.json"), "retained result\n");
  expect(await projectIdentityDigest(root, provenance, [results])).toBe(first);
  await writeFile(join(root, "case.json"), "changed\n");
  expect(await projectIdentityDigest(root, provenance, [results])).not.toBe(
    first,
  );
});
test("runner provenance uses package identity unless the running checkout is explicit", async () => {
  const digest = "a".repeat(64);
  const { version } = parseRecord(
    await readFile(resolve(import.meta.dir, "../package.json"), "utf8"),
  );
  expect(await runnerProvenance(digest)).toMatchObject({
    source: "package",
    packageName: "@bjoernrochel/sevro",
    version,
    buildDigest: digest,
  });
  const checkout = await runnerProvenance(
    digest,
    resolve(import.meta.dir, ".."),
  );
  expect(checkout).toMatchObject({
    source: "checkout",
    buildDigest: digest,
  });
  const unrelated = await mkdtemp(join(tmpdir(), "sevro-other-checkout-"));
  roots.push(unrelated);
  expect(runnerProvenance(digest, unrelated)).rejects.toThrow(
    "does not match the running package",
  );
});
test("project provenance distinguishes revision, tracked edits, and untracked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-project-git-"));
  roots.push(root);
  git(root, "init", "--quiet");
  await writeFile(join(root, "README.md"), "original\n");
  git(root, "add", "README.md");
  git(
    root,
    "-c",
    "user.name=Sevro Test",
    "-c",
    "user.email=sevro-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Seed fixture",
  );
  const clean = await projectProvenance(root);
  expect(clean.revision).toMatch(/^[a-f0-9]{40,64}$/);
  expect(clean.dirtyPatchDigest).toBeNull();
  const cleanDigest = await projectIdentityDigest(root, clean);
  await writeFile(join(root, "README.md"), "changed\n");
  const tracked = await projectProvenance(root);
  expect(tracked.revision).toBe(clean.revision);
  expect(tracked.dirtyPatchDigest).toMatch(/^[a-f0-9]{64}$/);
  const trackedDigest = await projectIdentityDigest(root, tracked);
  expect(trackedDigest).not.toBe(cleanDigest);
  await writeFile(join(root, "new.txt"), "untracked\n");
  const untracked = await projectProvenance(root);
  expect(untracked.revision).toBe(clean.revision);
  expect(untracked.dirtyPatchDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(untracked.dirtyPatchDigest).not.toBe(tracked.dirtyPatchDigest);
  expect(await projectIdentityDigest(root, untracked)).not.toBe(trackedDigest);
});
