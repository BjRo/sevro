import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { buildBlindAdvisoryFixture } from "../../../src/fixtures/advisory";
import { createTemporaryFixtures, fixtureGit } from "../../fixtures/filesystem";

const { retainTemporaryFixture, repositoryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

test("blind advisory review copies contained untracked symlinks and nested files without sharing source bytes", async () => {
  const source = await repositoryFixture();
  await mkdir(join(source.repository, "nested"));
  await writeFile(
    join(source.repository, "nested", "new.txt"),
    "candidate change\n",
  );
  await symlink("../README.md", join(source.repository, "nested", "shortcut"));
  const view = await buildBlindAdvisoryFixture(source.repository, {
    baseRevision: source.revision,
  });
  retainTemporaryFixture(view);
  expect(await realpath(view)).toBe(view);
  expect(await readlink(join(view, "nested", "shortcut"))).toBe("../README.md");
  expect(await readFile(join(view, "nested", "shortcut"), "utf8")).toBe(
    "baseline\n",
  );
  expect(await readFile(join(view, "nested", "new.txt"), "utf8")).toBe(
    "candidate change\n",
  );
  expect((await lstat(join(view, "nested", "new.txt"))).ino).not.toBe(
    (await lstat(join(source.repository, "nested", "new.txt"))).ino,
  );
  await writeFile(join(view, "nested", "new.txt"), "reviewer edit\n");
  expect(
    await readFile(join(source.repository, "nested", "new.txt"), "utf8"),
  ).toBe("candidate change\n");
  expect(await fixtureGit(view, "remote")).toBe("");
});

for (const tracked of [false, true]) {
  test(`blind advisory review refuses a ${tracked ? "tracked" : "untracked"} broken symlink`, async () => {
    const source = await repositoryFixture();
    await symlink("missing-target", join(source.repository, "broken"));
    if (tracked) {
      await fixtureGit(source.repository, "add", "broken");
      await fixtureGit(
        source.repository,
        "commit",
        "--quiet",
        "-m",
        "Broken link fixture",
      );
    }
    const revision = await fixtureGit(source.repository, "rev-parse", "HEAD");
    expect(
      buildBlindAdvisoryFixture(source.repository, { baseRevision: revision }),
    ).rejects.toThrow("broken symlink");
    expect(await readlink(join(source.repository, "broken"))).toBe(
      "missing-target",
    );
  });
}

test("blind advisory review requires an immutable base revision rather than a moving ref", async () => {
  const source = await repositoryFixture();
  expect(
    buildBlindAdvisoryFixture(source.repository, { baseRevision: "HEAD" }),
  ).rejects.toThrow("invalid advisory fixture source");
  expect(await fixtureGit(source.repository, "rev-parse", "HEAD")).toBe(
    source.revision,
  );
});

test("blind advisory review refuses an absolute symlink back to the source checkout", async () => {
  const source = await repositoryFixture();
  const original = join(source.repository, "README.md");
  await symlink(original, join(source.repository, "absolute-link"));
  expect(
    buildBlindAdvisoryFixture(source.repository, {
      baseRevision: source.revision,
    }),
  ).rejects.toThrow("escaping symlink");
  expect(await readlink(join(source.repository, "absolute-link"))).toBe(
    original,
  );
  expect(await readFile(original, "utf8")).toBe("baseline\n");
});
