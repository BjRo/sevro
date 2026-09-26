import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectProvenance } from "../src/provenance";

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

test("project provenance stays unknown without a Git revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-no-git-"));
  roots.push(root);
  expect(await projectProvenance(root)).toMatchObject({
    revision: null,
    dirtyPatchDigest: null,
  });
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
  await writeFile(join(root, "README.md"), "changed\n");
  const tracked = await projectProvenance(root);
  expect(tracked.revision).toBe(clean.revision);
  expect(tracked.dirtyPatchDigest).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(root, "new.txt"), "untracked\n");
  const untracked = await projectProvenance(root);
  expect(untracked.revision).toBe(clean.revision);
  expect(untracked.dirtyPatchDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(untracked.dirtyPatchDigest).not.toBe(tracked.dirtyPatchDigest);
});
