import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type HostAdapter } from "../../src/engine";
import { createTemporaryFixtures } from "./filesystem";

export const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));

export async function rootsForRun(roots: string[]) {
  const { temporaryFixture } = createTemporaryFixtures(roots);

  const root = await temporaryFixture(join(tmpdir(), "sevro-engine-test-"));

  return { projectRoot: root, resultsRoot: join(root, "results") };
}

export const digest = "a".repeat(64);

export async function waitForIsolationMarker(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("isolation barrier timed out");
    await Bun.sleep(10);
  }
}

/** Keep the advanced retention clock away from other runs' temporary data. */
export async function runRetentionInIsolation(
  roots: string[],
  testFile: string,
  pattern: string,
): Promise<boolean> {
  const { temporaryFixture } = createTemporaryFixtures(roots);

  if (process.env.SEVRO_RETENTION_TEST_ISOLATED === "1") return false;
  const scope = await temporaryFixture(join(tmpdir(), "sevro-retention-test-"));
  const argv = [
    process.execPath,
    "test",
    testFile,
    "--test-name-pattern",
    pattern,
  ];
  const command =
    process.platform === "linux"
      ? [
          "/usr/bin/bwrap",
          "--unshare-user",
          "--bind",
          "/",
          "/",
          "--dev-bind",
          "/dev",
          "/dev",
          "--proc",
          "/proc",
          "--tmpfs",
          "/var/tmp",
          "--",
          ...argv,
        ]
      : argv;
  try {
    const child = Bun.spawn(command, {
      cwd: resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        TMPDIR: scope,
        SEVRO_RETENTION_TEST_ISOLATED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, out + err).toBe(0);
    return true;
  } finally {
    await rm(scope, { recursive: true, force: true });
  }
}

export const baseCase = {
  id: "answer",
  prompt: "Return ready.",
  fixture: { files: { "README.md": "fixture content\n" } },
  checks: [
    {
      id: "response",
      grader: "sevro.regex" as const,
      configuration: { pattern: "^ready$" },
    },
  ],
  requiredEvidence: [],
};

export function failedRetentionOptions(
  paths: { projectRoot: string; resultsRoot: string },
  observeWorkspace: (workspace: string) => void,
) {
  return {
    ...paths,
    case: baseCase,
    host: {
      id: "example.failure",
      model: "synthetic",
      effort: "none",
      run(request: Parameters<HostAdapter["run"]>[0]) {
        observeWorkspace(request.workspace);
        return Promise.resolve({
          finalMessage: null,
          complete: false,
          executionFailed: true,
        });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
}
