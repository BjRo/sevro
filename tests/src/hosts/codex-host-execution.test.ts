import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluation } from "../../../src/engine";
import { createCodexHost } from "../../../src/hosts/codex";
import {
  defined,
  expectUnknown,
  parseRunEvidence,
} from "../../fixtures/assertions";
import { digest, fixture, isolatedNativeHost } from "../../fixtures/codex-host";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("Codex host verifies its permission profile and feeds the engine", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const outcome = await runEvaluation({
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    case: {
      id: "codex-case",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "fixture\n" } },
      checks: [
        {
          id: "response",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
        {
          id: "created",
          grader: "sevro.shell",
          configuration: { run: "test -f created.txt" },
        },
      ],
      requiredEvidence: ["sevro.codex.events"],
    },
    host,
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.exitCode).toBe(0);
  const raw = defined(defined(outcome.result.cases[0]).trials[0]);
  expectUnknown(raw.checks.map((check) => check.status)).toEqual([
    "passed",
    "passed",
  ]);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expectUnknown(defined(evidence.trials[0]).usage).toEqual({
    inputTokens: 12,
    outputTokens: 4,
    costUsd: null,
    complete: true,
  });
  expect(defined(evidence.trials[0]).condition.actual).toBe("passive");
  expect(defined(defined(evidence.trials[0]).routes[0])).toMatchObject({
    host: "sevro.host.codex",
    model: "synthetic-codex",
    effort: "low",
  });
  const [events] = defined(evidence.trials[0]).artifactRefs;
  expect(defined(events).id).toBe("sevro.codex.events");
  expect(await readFile(new URL(defined(events).path), "utf8")).toContain(
    '"type":"turn.completed"',
  );
});

test("Codex fixture tools survive login-shell PATH setup", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const outcome = await runEvaluation({
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    case: {
      id: "codex-fixture-tool",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [
          { message: "Initialize", files: { "README.md": "fixture\n" } },
        ],
        bin: { "fixture-tool": "#!/bin/sh\nprintf 'fixture tool\\n'\n" },
      },
      checks: [
        {
          id: "fixture-tool-output",
          grader: "sevro.shell",
          configuration: {
            run: "cat fixture-tool-output.txt",
            expectExact: "fixture tool",
          },
        },
      ],
      requiredEvidence: [],
    },
    host,
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.task.verdict).toBe("passed");
});

test("Codex host rejects malformed streams and unsupported enforcement", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const workspace = await temporaryFixture(join(tmpdir(), "sevro-case-codex-"));

  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  await writeFile(join(workspace, "malformed.flag"), "");
  expect(
    host.run({ prompt: "ready", workspace, condition: "passive" }),
  ).rejects.toThrow(/invalid JSONL/);
  expect(await readFile(join(workspace, "prompt.txt"), "utf8")).toBe("ready");
  const argv = await readFile(join(workspace, "argv.txt"), "utf8");
  expect(argv).toContain("--strict-config");
  expect(argv).toContain("default_permissions=");
  expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(
    host.run({ prompt: "ready", workspace, condition: "enforced" }),
  ).rejects.toThrow(/enforcement instrumentation/);
});

test("Codex host terminates a timed out turn", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-case-codex-slow-"),
  );

  await writeFile(join(workspace, "slow.flag"), "");
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
    timeoutMs: 50,
  });
  expect(
    host.run({ prompt: "ready", workspace, condition: "passive" }),
  ).rejects.toThrow(/timed out/);
});

test("Codex host kills its process group when cancelled", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-case-codex-cancelled-"),
  );

  await writeFile(join(workspace, "slow.flag"), "");
  const controller = new AbortController();
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const running = host.run({
    prompt: "ready",
    workspace,
    condition: "passive",
    signal: controller.signal,
  });
  const settled = running.catch(() => undefined);
  try {
    const pidPath = join(workspace, "child.pid");
    const deadline = Date.now() + 30_000;
    while (!(await Bun.file(pidPath).exists())) {
      if (Date.now() > deadline) throw new Error("Codex child did not start");
      await Bun.sleep(20);
    }
    const pid = Number(await readFile(pidPath, "utf8"));
    controller.abort();
    expect(running).rejects.toThrow(/cancelled/);
    await settled;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await settled;
  }
}, 60_000);

test("Codex host refuses an executable inside a protected project", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-case-codex-rejected-"),
  );

  const insideProject = join(paths.projectRoot, "fake-codex");
  await writeFile(insideProject, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const host = createCodexHost({
    binary: insideProject,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  expect(
    host.run({ prompt: "ready", workspace, condition: "passive" }),
  ).rejects.toThrow(/executable resides inside a protected root/);
});
