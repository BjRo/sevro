import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareFixtureSetup, runFixtureSetup } from "../src/fixture-setup";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("fixture setup resolves symbolic roots and runs only the declared argv", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "sevro-setup-workspace-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-setup-project-"));
  roots.push(workspace, projectRoot);
  const setup = prepareFixtureSetup({
    command: [
      process.execPath,
      "-e",
      'await Bun.write("setup.txt", process.env.CASE_ROOT + "|" + process.env.WORKSPACE);',
    ],
    environment: {
      CASE_ROOT: "{{sevro.project}}/cases",
      WORKSPACE: "{{sevro.workspace}}",
    },
  });
  expect(setup).not.toBeNull();
  await runFixtureSetup(setup!, { workspace, projectRoot });
  expect(await readFile(join(workspace, "setup.txt"), "utf8")).toBe(
    `${projectRoot}/cases|${workspace}`,
  );
  expect(() =>
    prepareFixtureSetup({ command: ["bash", "-c", "exit 0"] }),
  ).toThrow(/invalid fixture setup command/);
  expect(() =>
    prepareFixtureSetup({
      command: [process.execPath],
      environment: { PATH: "/tmp" },
    }),
  ).toThrow(/invalid fixture setup environment/);
});

test("fixture setup failure and cancellation never report success", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "sevro-setup-failure-"));
  roots.push(workspace);
  const failed = prepareFixtureSetup({
    command: [process.execPath, "-e", "process.exit(17)"],
  })!;
  expect(
    runFixtureSetup(failed, { workspace, projectRoot: workspace }),
  ).rejects.toThrow("fixture setup failed (17)");
  const abort = new AbortController();
  abort.abort();
  expect(
    runFixtureSetup(failed, {
      workspace,
      projectRoot: workspace,
      signal: abort.signal,
    }),
  ).rejects.toThrow("fixture setup cancelled");
});
