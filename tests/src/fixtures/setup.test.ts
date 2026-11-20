import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeFixture,
  prepareFixtureSetup,
  type FixtureSetup,
} from "../../../src/fixtures/index";
import { defined } from "../../fixtures/assertions";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, retainTemporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

async function setUpFixture(
  setup: FixtureSetup,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const workspace = await materializeFixture(
    { kind: "inline", files: {} },
    { setup, projectRoot, signal },
  );
  retainTemporaryFixture(workspace);
  return workspace;
}

test("fixture setup resolves symbolic roots and runs only the declared argv", async () => {
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
  const workspace = await setUpFixture(defined(setup), projectRoot);
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
  const projectRoot = await temporaryFixture(
    join(tmpdir(), "sevro-setup-failure-"),
  );

  const failed = defined(
    prepareFixtureSetup({
      command: [process.execPath, "-e", "process.exit(17)"],
    }),
  );
  const refused = setUpFixture(failed, projectRoot);
  expect(refused).rejects.toThrow("fixture setup failed (17)");
  await refused.catch(() => undefined);
  const abort = new AbortController();
  abort.abort();
  const cancelled = setUpFixture(failed, projectRoot, abort.signal);
  expect(cancelled).rejects.toThrow("fixture setup cancelled");
  await cancelled.catch(() => undefined);
});
