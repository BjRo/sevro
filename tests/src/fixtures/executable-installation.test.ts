import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  materializeFixture,
  prepareGeneratedFixture,
} from "../../../src/fixtures/index";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

const hookTarget = "fixture Git hook target is invalid";
const binDirectory = "fixture binary directory is invalid";

/** A reserved workspace whose Git metadata already holds a conflicting entry. */
async function seededWorkspace(
  seed: (git: string, root: string) => Promise<void>,
) {
  const root = await temporaryFixture();
  const workspace = join(root, "workspace");
  const git = join(workspace, ".git");
  await mkdir(join(git, "hooks"), { recursive: true });
  await seed(git, root);
  return { root, workspace, git };
}

function createToolFixture(
  tools: { hooks?: Record<string, string>; bin?: Record<string, string> },
  root: string,
  workspace: string,
) {
  const fixture = prepareGeneratedFixture({
    kind: "generated",
    commits: [{ message: "Baseline", files: { "README.md": "baseline\n" } }],
    ...tools,
  });
  return materializeFixture(
    { kind: "generated", fixture },
    { projectRoot: root, reservedWorkspace: workspace },
  );
}

test("fixture executable installation replaces only an existing regular target and sets its executable mode", async () => {
  const { root, workspace, git } = await seededWorkspace((git) =>
    writeFile(join(git, "hooks", "ready"), "old bytes", { mode: 0o600 }),
  );
  await createToolFixture(
    { hooks: { ready: "#!/bin/sh\necho ready\n" } },
    root,
    workspace,
  );
  const path = join(git, "hooks", "ready");
  expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho ready\n");
  expect((await stat(path)).mode & 0o777).toBe(0o755);
});

test.each(["directory", "symlink"])(
  "fixture executable installation refuses an existing %s target and preserves its contents",
  async (kind) => {
    const { root, workspace } = await seededWorkspace(async (git, root) => {
      const external = join(root, "external");
      await mkdir(external);
      await writeFile(join(external, "original.txt"), "original bytes");
      const target = join(git, "hooks", "ready");
      if (kind === "directory") await mkdir(target);
      else await symlink(join(external, "original.txt"), target);
    });
    const pending = createToolFixture(
      { hooks: { ready: "replaced bytes" } },
      root,
      workspace,
    );
    expect(pending).rejects.toThrow(hookTarget);
    await pending.catch(() => undefined);
    expect(await readFile(join(root, "external", "original.txt"), "utf8")).toBe(
      "original bytes",
    );
  },
);

test("fixture executable installation refuses a regular file directory boundary and preserves its bytes", async () => {
  const { root, workspace, git } = await seededWorkspace((git) =>
    writeFile(join(git, "fixture-bin"), "original bytes"),
  );
  const pending = createToolFixture(
    { bin: { ready: "new bytes" } },
    root,
    workspace,
  );
  expect(pending).rejects.toThrow(/EEXIST/);
  await pending.catch(() => undefined);
  expect(await readFile(join(git, "fixture-bin"), "utf8")).toBe(
    "original bytes",
  );
});

test("fixture executable installation refuses a symlink directory boundary without writing through it", async () => {
  const { root, workspace } = await seededWorkspace(async (git, root) => {
    await mkdir(join(root, "external"));
    await symlink(join(root, "external"), join(git, "fixture-bin"));
  });
  const pending = createToolFixture(
    { bin: { ready: "new bytes" } },
    root,
    workspace,
  );
  expect(pending).rejects.toThrow(binDirectory);
  await pending.catch(() => undefined);
  expect(await readdir(join(root, "external"))).toEqual([]);
});

test("fixture executable installation reports a real inaccessible owned directory without changing its files", async () => {
  const { root, workspace, git } = await seededWorkspace(async (git) => {
    await mkdir(join(git, "fixture-bin"));
    await writeFile(join(git, "fixture-bin", "original.txt"), "original bytes");
  });
  const directory = join(git, "fixture-bin");
  await chmod(directory, 0);
  try {
    const pending = createToolFixture(
      { bin: { ready: "new bytes" } },
      root,
      workspace,
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
