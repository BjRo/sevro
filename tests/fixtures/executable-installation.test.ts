import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { installFixtureTools } from "../../src/fixtures/tools";
import { createTemporaryFixtures } from "./filesystem";

const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

const toolMessages = {
  directory: "fixture tool directory must be real",
  target: "fixture tool target must be regular",
};

test("fixture executable installation replaces only an existing regular target and sets its executable mode", async () => {
  const root = await temporaryFixture();
  const path = join(root, "ready");
  await writeFile(path, "old bytes", { mode: 0o600 });
  await installFixtureTools(
    { ready: "#!/bin/sh\necho ready\n" },
    root,
    toolMessages,
  );
  expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho ready\n");
  expect((await stat(path)).mode & 0o777).toBe(0o755);
});

test.each(["directory", "symlink"])(
  "fixture executable installation refuses an existing %s target and preserves its contents",
  async (kind) => {
    const root = await temporaryFixture();
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "original.txt"), "original bytes");
    if (kind === "directory") await mkdir(join(root, "ready"));
    else await symlink(join(external, "original.txt"), join(root, "ready"));
    const pending = installFixtureTools(
      { ready: "replaced bytes" },
      root,
      toolMessages,
    );
    expect(pending).rejects.toThrow(toolMessages.target);
    await pending.catch(() => undefined);
    expect(await readFile(join(external, "original.txt"), "utf8")).toBe(
      "original bytes",
    );
  },
);

test.each(["regular file", "symlink"])(
  "fixture executable installation refuses a %s directory boundary",
  async (kind) => {
    const root = await temporaryFixture();
    const directory = join(root, "tools");
    await mkdir(join(root, "external"));
    if (kind === "regular file") await writeFile(directory, "original bytes");
    else await symlink("external", directory);
    const pending = installFixtureTools(
      { ready: "new bytes" },
      directory,
      toolMessages,
    );
    expect(pending).rejects.toThrow(toolMessages.directory);
    await pending.catch(() => undefined);
    expect(await readdir(join(root, "external"))).toEqual([]);
  },
);

test("fixture executable installation reports a real inaccessible owned directory without changing its files", async () => {
  const root = await temporaryFixture();
  const directory = join(root, "locked");
  await mkdir(directory);
  await writeFile(join(directory, "original.txt"), "original bytes");
  await chmod(directory, 0);
  try {
    const pending = installFixtureTools(
      { ready: "new bytes" },
      directory,
      toolMessages,
    );
    expect(pending).rejects.toThrow(/EACCES/);
    await pending.catch(() => undefined);
  } finally {
    await chmod(directory, 0o700);
  }
  expect(await readdir(directory)).toEqual(["original.txt"]);
  expect(await readFile(join(directory, "original.txt"), "utf8")).toBe(
    "original bytes",
  );
});
