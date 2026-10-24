import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareFixtureSetup,
  runFixtureSetup,
} from "../../../src/fixtures/setup";
import { defined } from "../../fixtures/assertions";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("fixture setup resolves symbolic roots and runs only the declared argv", async () => {
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-setup-workspace-"),
  );
  const projectRoot = await temporaryFixture(
    join(tmpdir(), "sevro-setup-project-"),
  );

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
  await runFixtureSetup(defined(setup), { workspace, projectRoot });
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
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-setup-failure-"),
  );

  const failed = defined(
    prepareFixtureSetup({
      command: [process.execPath, "-e", "process.exit(17)"],
    }),
  );
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
