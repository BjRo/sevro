import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectProvenance, runnerProvenance } from "../src/provenance";

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

test("runner provenance uses package identity unless the running checkout is explicit", async () => {
  const digest = "a".repeat(64);
  expect(await runnerProvenance(digest)).toMatchObject({
    source: "package",
    packageName: "sevro",
    version: "0.1.0-dev.0",
    buildDigest: digest,
  });
  const checkout = await runnerProvenance(
    digest,
    resolve(import.meta.dir, ".."),
  );
  expect(checkout).toMatchObject({ source: "checkout", buildDigest: digest });
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
