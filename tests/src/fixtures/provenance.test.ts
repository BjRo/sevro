import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkoutProvenance,
  packageBuildDigest,
  projectIdentityDigest,
  projectProvenance,
} from "../../../src/provenance";
import { createTemporaryFixtures, fixtureGit } from "../../fixtures/filesystem";

const { temporaryFixture, repositoryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

test("unborn Git repositories retain unknown project provenance rather than inventing a revision", async () => {
  const root = await temporaryFixture();
  await fixtureGit(root, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(root, "README.md"), "uncommitted content\n");
  const provenance = await projectProvenance(root);
  expect(provenance.revision).toBeNull();
  expect(provenance.dirtyPatchDigest).toBeNull();
  expect(await projectIdentityDigest(root, provenance)).toMatch(
    /^[a-f0-9]{64}$/,
  );
});

test("checkout provenance refuses a nested directory in place of the explicit Git root", async () => {
  const source = await repositoryFixture();
  await mkdir(join(source.repository, "nested"));
  const provenance = await checkoutProvenance(
    source.repository,
    "a".repeat(64),
  );
  expect(provenance.revision).toBe(source.revision);
  expect(
    checkoutProvenance(join(source.repository, "nested"), "a".repeat(64)),
  ).rejects.toThrow("checkout root does not match its Git repository");
});

test("non-Git project identity ignores relocation and timestamps but distinguishes executable content", async () => {
  const first = await temporaryFixture();
  const second = await temporaryFixture();
  await writeFile(join(first, "tool.sh"), "#!/bin/sh\necho ready\n", {
    mode: 0o600,
  });
  await writeFile(join(second, "tool.sh"), "#!/bin/sh\necho ready\n", {
    mode: 0o600,
  });
  const unknownGit = { revision: null, dirtyPatchDigest: null };
  const digest = await projectIdentityDigest(first, unknownGit);
  await utimes(
    join(second, "tool.sh"),
    new Date("2000-01-01T00:00:00Z"),
    new Date("2030-01-01T00:00:00Z"),
  );
  expect(await projectIdentityDigest(second, unknownGit)).toBe(digest);
  await chmod(join(second, "tool.sh"), 0o700);
  expect(await projectIdentityDigest(second, unknownGit)).not.toBe(digest);
  expect(await readFile(join(second, "tool.sh"), "utf8")).toBe(
    await readFile(join(first, "tool.sh"), "utf8"),
  );
});

async function packagedFixture(reverse: boolean): Promise<string> {
  const root = await temporaryFixture();
  for (const directory of ["docs", "examples", "schemas", "src"])
    await mkdir(join(root, directory));
  const paths = [
    "package.json",
    "README.md",
    "docs/spec.md",
    "examples/basic.json",
    "schemas/evidence.json",
    "src/first.ts",
    "src/second.ts",
  ];
  for (const path of reverse ? [...paths].reverse() : paths)
    await writeFile(join(root, path), `${path}\n`);
  return root;
}

test("package build identity uses declared runtime paths independent of filesystem insertion order and unrelated files", async () => {
  const first = await packagedFixture(false);
  const second = await packagedFixture(true);
  const digest = await packageBuildDigest(first);
  expect(await packageBuildDigest(second)).toBe(digest);
  await writeFile(join(second, "outside-runtime.txt"), "unrelated file\n");
  expect(await packageBuildDigest(second)).toBe(digest);
});
