import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runEvaluation, type HostAdapter } from "../../src/engine";
import { defined, expectUnknown } from "../fixtures/assertions";
import {
  baseCase,
  digest,
  isolatedNativeHost,
  rootsForRun,
  waitForIsolationMarker,
} from "../fixtures/engine";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("engine shell isolation hides a sibling created after sandbox launch", async () => {
  if (!isolatedNativeHost) return;
  const paths = await rootsForRun(roots);
  const control = await temporaryFixture(
    join(tmpdir(), "sevro-isolation-control-"),
  );

  const marker = join(control, "started");
  const published = join(control, "published");
  let prepared: Promise<void> = Promise.resolve();
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run({ workspace }) {
      prepared = (async () => {
        await waitForIsolationMarker(marker);
        const peer = join(
          dirname(workspace),
          `sevro-case-future-${basename(workspace)}`,
        );
        await mkdir(peer, { mode: 0o700 });
        roots.push(peer);
        await writeFile(join(peer, "secret"), "original");
        await writeFile(published, peer);
      })();
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  const outcome = await runEvaluation({
    ...paths,
    case: {
      ...baseCase,
      checks: [
        {
          id: "isolated",
          grader: "sevro.shell",
          configuration: {
            run: `touch '${marker}'
while ! test -f '${published}'; do sleep 0.01; done
peer=$(cat '${published}')
cat README.md >/dev/null
printf own > own-file
if cat "$peer/secret" >/dev/null 2>&1; then exit 1; fi
if (printf changed > "$peer/secret") 2>/dev/null; then exit 1; fi
if ls ../.owners >/dev/null 2>&1; then exit 1; fi
printf isolated`,
            expectExact: "isolated",
            timeoutMs: 10000,
          },
        },
      ],
    },
    host,
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  await prepared;
  expect(outcome.result.exitCode).toBe(0);
  expect(outcome.result.task.verdict).toBe("passed");
});

test("engine shell isolation hides project sources and explicitly protected peer fixtures", async () => {
  if (!isolatedNativeHost) return;
  const paths = await rootsForRun(roots);
  const peer = await temporaryFixture(join(tmpdir(), "sevro-case-peer-"));

  const projectSecret = join(paths.projectRoot, "source-secret.txt");
  const peerSecret = join(peer, "peer-secret.txt");
  await writeFile(projectSecret, "source\n");
  await writeFile(peerSecret, "peer\n");
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  const outcome = await runEvaluation({
    ...paths,
    case: {
      ...baseCase,
      checks: [projectSecret, peerSecret].map((path, index) => ({
        id: `hidden-${index}`,
        grader: "sevro.shell",
        configuration: {
          run: `/bin/cat '${path}' >/dev/null`,
          expectedExitCode: 1,
        },
      })),
    },
    host,
    shellIsolation: { protectedRoots: [peer] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.exitCode).toBe(0);
  expectUnknown(
    defined(defined(outcome.result.cases[0]).trials[0]).checks.map(
      (check) => check.status,
    ),
  ).toEqual(["passed", "passed"]);
});
