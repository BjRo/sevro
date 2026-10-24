import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  checkoutRunner,
  defined,
  parseRunEvidence,
} from "../../fixtures/assertions";
import { createFixture, digest, invoke } from "../../fixtures/cli-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const testDirectory = join(import.meta.dir, "../..");

const roots: string[] = [];

const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const fixture = createFixture(roots);

test("CLI derives stable build and project digests without caller inputs", async () => {
  const { args } = await fixture();
  const automatic = args.filter(
    (part, index) =>
      !["--runner-build-digest", "--project-digest"].includes(part) &&
      !["--runner-build-digest", "--project-digest"].includes(
        args[index - 1] ?? "",
      ),
  );
  const first = await invoke(automatic);
  const second = await invoke(automatic);
  expect(first.code, first.stderr).toBe(0);
  expect(second.code, second.stderr).toBe(0);
  const firstEvidence = parseRunEvidence(
    await readFile(defined(first.result.evidencePath), "utf8"),
  );
  const secondEvidence = parseRunEvidence(
    await readFile(defined(second.result.evidencePath), "utf8"),
  );
  const dimensions = firstEvidence.evaluationIdentity.dimensions;
  expect(dimensions.runnerBuildDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(dimensions.projectDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(firstEvidence.runner.buildDigest).toBe(dimensions.runnerBuildDigest);
  expect(secondEvidence.evaluationIdentity.dimensions.projectDigest).toBe(
    dimensions.projectDigest,
  );
  const invalid = await invoke([...automatic, "--project-digest", "bad"]);
  expect(invalid.code).toBe(64);
});

test("CLI records an explicitly selected local runner checkout", async () => {
  const { args } = await fixture();
  const checkout = resolve(testDirectory, "..");
  const run = await invoke([...args, "--runner-checkout-root", checkout]);
  expect(run.code, run.stderr).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(evidence.runner).toMatchObject({
    source: "checkout",
    buildDigest: digest,
  });
  expect(checkoutRunner(evidence.runner).revision).toMatch(/^[a-f0-9]{40,64}$/);
  expect(
    checkoutRunner(evidence.runner).dirtyPatchDigest === null ||
      /^[a-f0-9]{64}$/.test(
        defined(checkoutRunner(evidence.runner).dirtyPatchDigest),
      ),
  ).toBeTrue();
  const invalid = await invoke([
    ...args,
    "--runner-checkout-root",
    join(checkout, "src"),
  ]);
  expect(invalid.code).toBe(64);
  expect(defined(invalid.result.diagnostic).message).toMatch(
    /does not match the running package/,
  );
});
