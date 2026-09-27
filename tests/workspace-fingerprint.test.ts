import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceFingerprint } from "../src/hosts/workspace-fingerprint";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("oversized workspace contents leave continuation identity unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-fingerprint-large-"));
  roots.push(root);
  const file = await open(join(root, "large.bin"), "w");
  try {
    await file.truncate(129 * 1024 * 1024);
  } finally {
    await file.close();
  }
  expect(await workspaceFingerprint(root)).toBeNull();
});

test("workspace identity tracks visible content and mode but ignores Git state", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-fingerprint-"));
  roots.push(root);
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "README.md"), "ready\n");
  const baseline = await workspaceFingerprint(root);
  expect(baseline).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(root, ".git", "internal"), "private state\n");
  expect(await workspaceFingerprint(root)).toBe(baseline);
  await writeFile(join(root, "README.md"), "changed\n");
  const changed = await workspaceFingerprint(root);
  expect(changed).not.toBe(baseline);
  await chmod(join(root, "README.md"), 0o700);
  expect(await workspaceFingerprint(root)).not.toBe(changed);
});
