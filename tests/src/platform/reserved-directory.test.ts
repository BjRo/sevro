import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { copyIntoReservedDirectory } from "../../../src/platform/index";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

/** Settle an expected rejection before later assertions inspect the disk. */
async function refusal(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("operation unexpectedly succeeded");
}

async function sourceTree(root: string): Promise<string> {
  const source = join(root, "source");
  await mkdir(join(source, "nested", "deeper"), { recursive: true });
  await writeFile(join(source, "top.txt"), "top\n");
  await writeFile(join(source, "nested", "deeper", "leaf.txt"), "leaf\n");
  return source;
}

test("copies a tree into the reserved directory and keeps the reservation", async () => {
  const root = await temporaryFixture();
  const source = await sourceTree(root);
  const reserved = join(root, "reserved");
  await mkdir(reserved, { mode: 0o700 });
  const before = await stat(reserved);

  await copyIntoReservedDirectory(source, reserved);

  const after = await stat(reserved);
  expect(after.ino).toBe(before.ino);
  expect(after.mode & 0o777).toBe(0o700);
  expect((await readdir(reserved)).sort()).toEqual(["nested", "top.txt"]);
  expect(await readFile(join(reserved, "top.txt"), "utf8")).toBe("top\n");
  expect(
    await readFile(join(reserved, "nested", "deeper", "leaf.txt"), "utf8"),
  ).toBe("leaf\n");
});

test("refuses a reserved directory that already has content", async () => {
  const root = await temporaryFixture();
  const source = await sourceTree(root);
  const reserved = join(root, "reserved");
  await mkdir(reserved);
  await writeFile(join(reserved, "existing.txt"), "keep\n");

  expect(await refusal(copyIntoReservedDirectory(source, reserved))).toBe(
    `reserved directory is not empty: ${reserved}`,
  );
  expect(await readdir(reserved)).toEqual(["existing.txt"]);
  expect(await readFile(join(reserved, "existing.txt"), "utf8")).toBe("keep\n");
});

test("refuses a destination that was never reserved", async () => {
  const root = await temporaryFixture();
  const source = await sourceTree(root);
  const missing = join(root, "missing");

  expect(await refusal(copyIntoReservedDirectory(source, missing))).toContain(
    "ENOENT",
  );
  expect(await refusal(lstat(missing))).toContain("ENOENT");
});

test("copies symbolic links as links unless dereferencing is requested", async () => {
  const root = await temporaryFixture();
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(root, "target.txt"), "target\n");
  await symlink(join(root, "target.txt"), join(source, "link.txt"));
  const preserved = join(root, "preserved");
  const dereferenced = join(root, "dereferenced");
  await Promise.all([mkdir(preserved), mkdir(dereferenced)]);

  await copyIntoReservedDirectory(source, preserved);
  await copyIntoReservedDirectory(source, dereferenced, { dereference: true });

  expect((await lstat(join(preserved, "link.txt"))).isSymbolicLink()).toBe(
    true,
  );
  const copied = await lstat(join(dereferenced, "link.txt"));
  expect(copied.isFile()).toBe(true);
  expect(await readFile(join(dereferenced, "link.txt"), "utf8")).toBe(
    "target\n",
  );
});
