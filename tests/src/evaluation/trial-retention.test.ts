import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, watch } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRuntimeConfiguration,
  runEvaluation,
  type EvaluationOptions,
} from "../../../src/engine";
import {
  defined,
  parseRecord,
  parseRunEvidence,
  string,
} from "../../fixtures/assertions";
import {
  createEvaluation,
  createSetupEvaluation,
  observation,
  requireSemantic,
} from "../../fixtures/evaluation-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const evaluation = createEvaluation(roots);

const setupEvaluation = createSetupEvaluation(evaluation);

test.each(["failed", "timedout", "cancelled"])(
  "removes fallback checker state after %s grading",
  async (ending) => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    options.shellIsolation = { protectedRoots: [] };
    const abort = new AbortController();
    options.signal = abort.signal;
    let workspace = "";
    options.host.run = async (request) => {
      workspace = request.workspace;
      roots.push(workspace);
      await mkdir(join(workspace, ".git/sevro-runtime"), { recursive: true });
      await writeFile(
        join(workspace, ".git/sevro-runtime/candidate-state"),
        "retain",
      );
      return { finalMessage: "ready", complete: true };
    };
    options.case.checks = [
      {
        id: "ending",
        grader: "sevro.shell",
        configuration: {
          run:
            'printf "%s" "$TMPDIR" > checker-temp; printf "%s" "$HOME" > checker-home; ' +
            (ending === "failed" ? "exit 1" : "sleep 10"),
          timeoutMs: ending === "timedout" ? 100 : 3000,
        },
      },
    ];
    const poll = setInterval(() => {
      if (ending === "cancelled" && existsSync(join(workspace, "checker-home")))
        abort.abort("SIGINT");
    }, 10);
    try {
      const { result } = await runEvaluation(options);
      const expectedExitCodes: Record<string, number> = {
        failed: 1,
        timedout: 3,
        cancelled: 130,
      };
      expect(result.exitCode).toBe(defined(expectedExitCodes[ending]));
      expect(
        existsSync(await readFile(join(workspace, "checker-home"), "utf8")),
      ).toBe(false);
      expect(
        existsSync(await readFile(join(workspace, "checker-temp"), "utf8")),
      ).toBe(false);
      expect(
        await readFile(
          join(workspace, ".git/sevro-runtime/candidate-state"),
          "utf8",
        ),
      ).toBe("retain");
      expect(existsSync(result.evidencePath)).toBe(true);
    } finally {
      clearInterval(poll);
    }
  },
);

test.each(["failed", "timedout", "cancelled"])(
  "checker cleanup preserves a shared cache after %s grading",
  async (ending) => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    const source = await temporaryFixture(
      join(tmpdir(), "sevro-persistent-check-cache-"),
    );

    await writeFile(join(source, "dependency"), "prepared");
    await writeFile(
      join(options.projectRoot, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { CACHE: "{{sevro.runtime}}/cache" } },
        runtime: {
          sharedCacheDirectories: [
            { source, target: "cache", roles: ["checks"] },
          ],
        },
      }),
    );
    options.runtimePolicy = await loadRuntimeConfiguration(options.projectRoot);
    options.shellIsolation = { protectedRoots: [] };
    const abort = new AbortController();
    options.signal = abort.signal;
    let workspace = "";
    options.host.run = (request) => {
      workspace = request.workspace;
      roots.push(workspace);
      return Promise.resolve({ finalMessage: "ready", complete: true });
    };
    options.case.checks = [
      {
        id: "ending",
        grader: "sevro.shell",
        configuration: {
          run:
            'cat "$CACHE/dependency" > dependency; printf "%s" "$HOME" > checker-home; ' +
            (ending === "failed" ? "exit 1" : "sleep 10"),
          timeoutMs: ending === "timedout" ? 100 : 3000,
        },
      },
    ];
    const poll = setInterval(() => {
      if (ending === "cancelled" && existsSync(join(workspace, "checker-home")))
        abort.abort("SIGINT");
    }, 10);
    try {
      const { result } = await runEvaluation(options);
      const expectedExitCodes: Record<string, number> = {
        failed: 1,
        timedout: 3,
        cancelled: 130,
      };
      expect(result.exitCode).toBe(defined(expectedExitCodes[ending]));
      const home = await readFile(join(workspace, "checker-home"), "utf8");
      expect(existsSync(home)).toBe(false);
      expect(await readFile(join(source, "dependency"), "utf8")).toBe(
        "prepared",
      );
      expect(existsSync(result.evidencePath)).toBe(true);
    } finally {
      clearInterval(poll);
    }
  },
);

test("removes read-only checker runtime after failed grading", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const source = await temporaryFixture(
    join(tmpdir(), "sevro-readonly-check-seed-"),
  );

  await mkdir(join(source, "nested"));
  await writeFile(join(source, "nested/dependency"), "prepared");
  await chmod(join(source, "nested"), 0o500);
  await writeFile(
    join(options.projectRoot, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: {
        seedDirectories: [{ source, target: "cache", roles: ["checks"] }],
      },
    }),
  );
  options.runtimePolicy = await loadRuntimeConfiguration(options.projectRoot);
  options.shellIsolation = { protectedRoots: [] };
  let workspace = "";
  options.host.run = (request) => {
    workspace = request.workspace;
    roots.push(workspace);
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  options.case.checks = [
    {
      id: "failed-check",
      grader: "sevro.shell",
      configuration: { run: 'printf "%s" "$HOME" > checker-home; exit 1' },
    },
  ];
  const homes: string[] = [];
  options.onProgress = (event) => {
    if (event.stage === "grading" && event.status === "completed")
      homes.push(readFileSync(join(workspace, "checker-home"), "utf8"));
  };
  try {
    const { result } = await runEvaluation(options);
    expect(result.exitCode).toBe(1);
    expect(existsSync(defined(homes[0]))).toBe(false);
    expect(existsSync(workspace)).toBe(true);
    expect(
      parseRunEvidence(await readFile(result.evidencePath, "utf8")).result.task
        .verdict,
    ).toBe("failed");
    expect(await readFile(join(source, "nested/dependency"), "utf8")).toBe(
      "prepared",
    );
  } finally {
    await chmod(join(source, "nested"), 0o700);
  }
});

test("removes checker runtime after successful grading", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  options.runtimePolicy = {
    format: "sevro.runtime.v1",
    environment: {},
    readOnlyRoots: [],
  };
  options.shellIsolation = { protectedRoots: [] };
  options.case.checks = [
    {
      id: "checker-home",
      grader: "sevro.shell",
      configuration: { run: 'printf "%s" "$HOME" > checker-home' },
    },
  ];
  let workspace = "";
  options.host.run = (request) => {
    workspace = request.workspace;
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  const homes: string[] = [];
  options.onProgress = (event) => {
    if (event.stage === "grading" && event.status === "completed")
      homes.push(readFileSync(join(workspace, "checker-home"), "utf8"));
  };
  const { result } = await runEvaluation(options);
  expect(result.exitCode).toBe(0);
  expect(homes).toHaveLength(1);
  expect(existsSync(defined(homes[0]))).toBe(false);
  expect(
    parseRunEvidence(await readFile(result.evidencePath, "utf8")).result.task
      .verdict,
  ).toBe("passed");
});

test("does not copy an implicit UV seed into a non-UV grader", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const source = await temporaryFixture(
    join(tmpdir(), "sevro-public-uv-seed-"),
  );

  await writeFile(join(source, "dependency"), "prepared dependency");
  await writeFile(
    join(options.projectRoot, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { UV_CACHE_DIR: "{{sevro.runtime}}/uv-cache" } },
      runtime: { seedDirectories: [{ source, target: "uv-cache" }] },
    }),
  );
  options.runtimePolicy = await loadRuntimeConfiguration(options.projectRoot);
  options.shellIsolation = { protectedRoots: [] };
  options.host.run = (request) => {
    roots.push(request.workspace);
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  options.case.checks = [
    {
      id: "no-uv-cache",
      grader: "sevro.shell",
      configuration: { run: 'test ! -d "$HOME/../uv-cache"' },
    },
  ];
  const { result } = await runEvaluation(options);
  expect(result.exitCode).toBe(0);
  expect(await readFile(join(source, "dependency"), "utf8")).toBe(
    "prepared dependency",
  );
});

test("shell checks reuse one declared cache across concurrent trials and runs", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const source = await temporaryFixture(
    join(homedir(), ".sevro-shared-check-cache-"),
  );

  await writeFile(join(source, "dependency"), "prepared dependency");
  await writeFile(
    join(options.projectRoot, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: {
        set: {
          UV_CACHE_DIR: "{{sevro.runtime}}/uv-cache",
          SHARED_SOURCE: source,
        },
      },
      runtime: {
        sharedCacheDirectories: [
          { source, target: "uv-cache", roles: ["checks"] },
        ],
      },
    }),
  );
  options.runtimePolicy = await loadRuntimeConfiguration(options.projectRoot);
  options.shellIsolation = { protectedRoots: [] };
  options.trialCount = 2;
  options.jobs = 2;
  options.host.run = (request) => {
    roots.push(request.workspace);
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  options.case.checks = [
    {
      id: "shared-cache",
      grader: "sevro.shell",
      configuration: {
        run: 'test "$UV_CACHE_DIR/dependency" -ef "$SHARED_SOURCE/dependency"; printf "used\\n" >> "$UV_CACHE_DIR/uses"',
      },
    },
  ];
  expect((await runEvaluation(options)).result.exitCode).toBe(0);
  expect((await runEvaluation(options)).result.exitCode).toBe(0);
  expect(await readFile(join(source, "uses"), "utf8")).toBe(
    "used\nused\nused\nused\n",
  );
  expect(await readFile(join(source, "dependency"), "utf8")).toBe(
    "prepared dependency",
  );
});

async function cancelReadySetup(options: EvaluationOptions) {
  const abort = new AbortController();
  options.signal = abort.signal;
  const ready = Promise.withResolvers<undefined>();
  const observer = watch(options.projectRoot, (_event, name) => {
    if (name === "setup-ready.json") ready.resolve(undefined);
  });
  const poll = setInterval(() => {
    if (existsSync(join(options.projectRoot, "setup-ready.json")))
      ready.resolve(undefined);
  }, 20);
  const timer = setTimeout(() => {
    ready.reject(new Error("Fixture setup did not publish readiness"));
  }, 5000);
  const pending = runEvaluation(options);
  try {
    await Promise.race([
      ready.promise,
      pending.then(() => {
        throw new Error("Evaluation finished before setup readiness");
      }),
    ]);
    const receipt = parseRecord(
      await readFile(join(options.projectRoot, "setup-ready.json"), "utf8"),
    );
    expect(receipt).toHaveProperty("phase", "setup-running");
    abort.abort("SIGINT");
    return await pending;
  } finally {
    abort.abort("SIGINT");
    observer.close();
    clearInterval(poll);
    clearTimeout(timer);
    await pending.catch(() => undefined);
  }
}

test("active trusted fixture setup cancellation retains an interrupted unassessed run before candidate admission", async () => {
  const options = await setupEvaluation([process.execPath, "-e", ""]);
  const script = join(options.projectRoot, "setup.ts");
  await writeFile(
    script,
    `
    import { writeFileSync, renameSync } from "node:fs";
    import { join } from "node:path";
    const root = process.argv[2];
    writeFileSync(join(root, "setup-ready.tmp"), JSON.stringify({phase: "setup-running"}));
    renameSync(join(root, "setup-ready.tmp"), join(root, "setup-ready.json"));
    setInterval(() => {}, 1000);
  `,
  );
  const configured = await setupEvaluation([
    process.execPath,
    script,
    options.projectRoot,
  ]);
  let candidateCalls = 0;
  configured.host.run = () => {
    candidateCalls++;
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  configured.projectRoot = options.projectRoot;
  const { result } = await cancelReadySetup(configured);
  expect(candidateCalls).toBe(0);
  expect(result.execution.status).toBe("cancelled");
  expect(result.grading.status).toBe("not_requested");
  expect(result.task.verdict).toBe("not_assessed");
  expect(result.exitCode).toBe(130);
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(evidence.result.execution.status).toBe("cancelled");
});

test("fixture setup interruption retains a prior completed trial and one cancelled partial attempt", async () => {
  const base = await evaluation({ finalMessage: "ready", complete: true });
  const code = `
    const fs = require("node:fs"), path = require("node:path"), root = process.argv[1];
    const first = path.join(root, "first-setup-complete");
    if (fs.existsSync(first)) {
      fs.writeFileSync(path.join(root, "setup-ready.tmp"), JSON.stringify({phase: "setup-running"}));
      fs.renameSync(path.join(root, "setup-ready.tmp"), path.join(root, "setup-ready.json"));
      setInterval(() => {}, 1000);
    } else fs.writeFileSync(first, "prepared");
  `;
  const options = await setupEvaluation([
    process.execPath,
    "-e",
    code,
    base.projectRoot,
  ]);
  options.projectRoot = base.projectRoot;
  options.trialCount = 2;
  options.jobs = 1;
  let candidateCalls = 0;
  options.host.run = () => {
    candidateCalls++;
    return Promise.resolve({
      finalMessage: "ready",
      complete: true,
      observations: [observation("example.evidence")],
    });
  };
  const { result } = await cancelReadySetup(options);
  expect(result.exitCode).toBe(130);
  expect(candidateCalls).toBe(1);
  const trials = defined(result.cases[0]).trials;
  expect(
    trials.map((trial) => [trial.execution.status, trial.task.verdict]),
  ).toEqual([
    ["completed", "passed"],
    ["cancelled", "not_assessed"],
  ]);
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(evidence.trials).toHaveLength(2);
  expect(
    await readFile(
      new URL(defined(defined(evidence.trials[0]).rawResult.path)),
      "utf8",
    ),
  ).toBe("ready");
  expect(defined(evidence.trials[1]).candidateDurationMs).toBeNull();
  expect(defined(evidence.trials[1]).rawResult.path).toBeNull();
});

test("ordinary trusted fixture setup failure stays a failure before candidate admission", async () => {
  const receiptRoot = await temporaryFixture(
    join(tmpdir(), "sevro-setup-failure-receipt-"),
  );

  const receiptPath = join(receiptRoot, "failure.json");
  const code = `require("node:fs").writeFileSync(process.argv[1], JSON.stringify({workspace: process.cwd()})); process.exit(7);`;
  const options = await setupEvaluation([
    process.execPath,
    "-e",
    code,
    receiptPath,
  ]);
  let candidateCalls = 0;
  options.host.run = () => {
    candidateCalls++;
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  const pending = runEvaluation(options);
  expect(pending).rejects.toThrow("fixture setup failed (7)");
  await pending.catch(() => undefined);
  const receipt = parseRecord(await readFile(receiptPath, "utf8"));
  const workspace = string(receipt.workspace);
  try {
    expect(candidateCalls).toBe(0);
    expect(options.signal).toBeUndefined();
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "baseline\n",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ownership initialization failure removes separately allocated run and state directories before candidate admission", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const stateRoot = join(options.projectRoot, "state");
  await mkdir(stateRoot);
  await writeFile(join(stateRoot, "owners"), "preserved blocking file\n");
  options.runStateRoot = stateRoot;
  let candidateCalls = 0;
  options.host.run = () => {
    candidateCalls++;
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  const pending = runEvaluation(options);
  expect(pending).rejects.toThrow();
  await pending.catch(() => undefined);
  expect(candidateCalls).toBe(0);
  expect(await readdir(options.resultsRoot)).toEqual([]);
  expect((await readdir(stateRoot)).sort()).toEqual(["locks", "owners"]);
  expect(await readFile(join(stateRoot, "owners"), "utf8")).toBe(
    "preserved blocking file\n",
  );
});

test("retains a failed host's raw response and artifacts before fixture cleanup", async () => {
  const bytes = Buffer.from("private diagnostic trace\n");
  const options = await evaluation({
    finalMessage: "ready",
    complete: false,
    executionFailed: true,
    artifacts: [{ id: "example.trace", bytes }],
    observations: [observation("example.receipt")],
  });
  let workspace = "";
  const host = options.host;
  options.host = {
    ...host,
    run(request) {
      workspace = request.workspace;
      return host.run(request);
    },
  };
  const outcome = await runEvaluation(options);
  expect(outcome.result.execution.status).toBe("failed");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(defined(defined(outcome.result.cases[0]).trials[0]).checks).toEqual(
    [],
  );
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  expect(await readFile(new URL(defined(trial.rawResult.path)), "utf8")).toBe(
    "ready",
  );
  const artifact = defined(
    trial.artifactRefs.find((item) => item.id === "example.trace"),
  );
  expect(await readFile(new URL(artifact.path))).toEqual(bytes);
  expect(artifact.sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(
    trial.observations.find((item) => item.id === "example.receipt"),
  ).toMatchObject({ completeness: "complete", data: { ready: true } });
  expect(workspace).not.toBe("");
  expect(existsSync(workspace)).toBe(true);
  roots.push(workspace);
});

test("retains semantic-phase cancellation and interrupted ownership before further trial admission", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const controller = new AbortController();
  options.signal = controller.signal;
  options.runStateRoot = join(options.projectRoot, "state");
  options.trialCount = 2;
  options.jobs = 1;
  requireSemantic(options, { finalMessage: "unused", complete: true });
  let calls = 0;
  let workspace = "";
  options.semanticHost = {
    ...defined(options.semanticHost),
    run(request) {
      calls++;
      workspace = request.workspace;
      expect(request.signal).toBe(controller.signal);
      controller.abort("SIGTERM");
      return Promise.reject(new Error("grader cooperatively cancelled"));
    },
  };
  const outcome = await runEvaluation(options);
  expect(calls).toBe(1);
  expect(outcome.result.execution.status).toBe("cancelled");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(outcome.result.exitCode).toBe(143);
  expect(defined(outcome.result.cases[0]).trials).toHaveLength(1);
  expect(existsSync(workspace)).toBe(true);
  roots.push(workspace);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expect(
    await readFile(
      new URL(defined(defined(evidence.trials[0]).rawResult.path)),
      "utf8",
    ),
  ).toBe("ready");
  const active = parseRecord(
    await readFile(
      join(options.runStateRoot, "active", `${outcome.result.runId}.json`),
      "utf8",
    ),
  );
  expect(active.status).toBe("interrupted");
});
