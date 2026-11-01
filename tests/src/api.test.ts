import { afterEach, expect, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type EvaluationProgress } from "../../src/index";
import baseline from "../../examples/basic/graded.json";
import { createTemporaryFixtures } from "../fixtures/filesystem";
import { parseRunEvidence } from "../fixtures/assertions";
import { removeWorkspace } from "../../src/fixtures/workspace-state";
import { cli } from "../fixtures/cli-fixtures";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

async function invocation() {
  const root = await temporaryFixture(join(tmpdir(), "sevro-api-"));
  const caseFile = join(root, "case.json");
  await writeFile(caseFile, JSON.stringify(baseline));
  return {
    root,
    caseFile,
    argv: [
      "run",
      "--case-file",
      caseFile,
      "--adapter-module",
      join(import.meta.dirname, "../../examples/basic/host.ts"),
      "--project-root",
      root,
    ],
  };
}

test("public evaluation prepares identity and returns an assessment without owning the process", async () => {
  const { argv } = await invocation();
  const progress: EvaluationProgress[] = [];
  const exitCode = process.exitCode;
  const intListeners = process.listenerCount("SIGINT");
  const termListeners = process.listenerCount("SIGTERM");
  const result = await evaluate({
    argv,
    onProgress: (event) => progress.push(event),
  });
  expect(result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "passed" },
    exitCode: 0,
  });
  expect(result.cases[0]?.trials[0]?.checks[0]?.status).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(evidence.evaluationIdentity.dimensions.projectDigest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(progress).toContainEqual({ stage: "evidence", status: "completed" });
  expect(process.exitCode).toBe(exitCode);
  expect(process.listenerCount("SIGINT")).toBe(intListeners);
  expect(process.listenerCount("SIGTERM")).toBe(termListeners);
});

test("failed assessment returns a typed failure while invalid configuration rejects", async () => {
  const { argv, caseFile } = await invocation();
  await writeFile(
    caseFile,
    JSON.stringify({
      ...baseline,
      checks: [
        {
          id: "wrong",
          grader: "sevro.regex",
          configuration: { pattern: "^wrong$" },
        },
      ],
    }),
  );
  const result = await evaluate({ argv });
  expect(result).toMatchObject({
    execution: { status: "completed" },
    task: { verdict: "failed" },
    exitCode: 1,
  });
  expect(evaluate({ argv: [...argv, "--threshold", "2"] })).rejects.toThrow(
    "invalid --threshold",
  );
});

test("caller cancellation stops queued trials and retains evidence despite a failing observer", async () => {
  const { argv } = await invocation();
  const controller = new AbortController();
  const result = await evaluate({
    argv: [...argv, "--trials", "3", "--jobs", "1"],
    signal: controller.signal,
    onProgress(event) {
      if (event.stage === "candidate" && event.status === "started")
        controller.abort("SIGINT");
      throw new Error("observer is unavailable");
    },
  });
  expect(result.execution.status).toBe("cancelled");
  expect(result.task.verdict).toBe("not_assessed");
  expect(result.exitCode).toBe(130);
  expect(result.cases[0]?.trials.length).toBeLessThan(3);
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(evidence.result.execution.status).toBe("cancelled");
});

test("deprecation warnings are optional callback observations", async () => {
  const { argv, root } = await invocation();
  const warnings: string[] = [];
  const legacy = [...argv, "--toolchain-bin-dir", root];
  const result = await evaluate({
    argv: legacy,
    onWarning: (message) => warnings.push(message),
  });
  expect(result.task.verdict).toBe("passed");
  expect(warnings).toEqual([
    "--toolchain-bin-dir is deprecated; declare the runtime in sevro.json or --runtime-config-file instead",
  ]);
  expect((await evaluate({ argv: legacy })).task.verdict).toBe("passed");
});

async function cleanupInvocation() {
  const { argv, root } = await invocation();
  const workspaceFile = join(root, "workspace.txt");
  const host = join(root, "cleanup-host.ts");
  await writeFile(
    host,
    `import { rm, writeFile } from "node:fs/promises";
export default { id: "test.cleanup", model: "deterministic", effort: "none", async run({ workspace }: { workspace: string }) {
  await writeFile(${JSON.stringify(workspaceFile)}, workspace);
  await rm(workspace, { recursive: true, force: true });
  return { finalMessage: "ready", complete: true };
} };`,
  );
  return { argv: [...argv, "--adapter-module", host], workspaceFile };
}

test.each(["capture", "silent", "throw"] as const)(
  "embedding cleanup warnings use the caller callback without console output (%s)",
  async (mode) => {
    const { argv, workspaceFile } = await cleanupInvocation();
    const warnings: string[] = [];
    const observers = {
      capture: (message: string) => {
        warnings.push(message);
      },
      silent: undefined,
      throw: () => {
        throw new Error("warning observer unavailable");
      },
    };
    const consoleWarning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await evaluate({ argv, onWarning: observers[mode] });
      expect(result.task.verdict).toBe("passed");
      expect(warnings).toHaveLength(mode === "capture" ? 1 : 0);
      if (mode === "capture")
        expect(warnings[0]).toContain("fixture cleanup failed; retained at");
      expect(consoleWarning).not.toHaveBeenCalled();
    } finally {
      consoleWarning.mockRestore();
      await removeWorkspace(await readFile(workspaceFile, "utf8"));
    }
  },
);

test("CLI preserves cleanup diagnostics after sharing embedding evaluation", async () => {
  const { argv, workspaceFile } = await cleanupInvocation();
  try {
    const child = Bun.spawn([process.execPath, cli, ...argv, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout) as unknown).toMatchObject({
      task: { verdict: "passed" },
    });
    expect(stderr).toContain("fixture cleanup failed; retained at");
  } finally {
    await removeWorkspace(await readFile(workspaceFile, "utf8"));
  }
});
