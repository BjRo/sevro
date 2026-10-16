import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCliResult, assertRunEvidence } from "../../src/schema";
import type { CliResultData } from "../../src/schema-types";

const repository = resolve(import.meta.dir, "../..");

async function readResult(path: string) {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assertCliResult(value);
  return value;
}

async function assertRetained(result: CliResultData, results: string) {
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.execution, { status: "completed" });
  assert.deepEqual(result.grading, { status: "not_requested" });
  assert.deepEqual(result.task, { verdict: "not_assessed" });
  assert.equal(result.cases.length, 1);
  const selected = result.cases[0];
  assert(selected);
  assert.equal(selected.caseId, "adapter-prompt-only");
  assert.equal(selected.trials.length, 1);
  const trial = selected.trials[0];
  assert(trial);
  assert.deepEqual(trial.checks, []);
  assert(result.evidencePath);
  const evidence: unknown = JSON.parse(
    await readFile(result.evidencePath, "utf8"),
  );
  assertRunEvidence(evidence);
  assert.deepEqual(evidence.result, result);
  assert.deepEqual(evidence.routes, [
    {
      role: "candidate",
      host: "sevro.host.synthetic",
      model: "synthetic-v1",
      effort: "none",
    },
  ]);
  assert.equal(evidence.trials.length, 1);
  const retained = evidence.trials[0];
  assert(retained);
  assert.equal(retained.executionMode, "executed");
  assert.equal(retained.observationCompleteness, "complete");
  assert.deepEqual(retained.usage, {
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    complete: false,
  });
  assert.equal(retained.rawResult.source, "sevro.host.synthetic");
  assert.equal(
    retained.rawResult.sha256,
    "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6",
  );
  assert(retained.rawResult.path);
  assert.equal(
    await readFile(fileURLToPath(retained.rawResult.path), "utf8"),
    "ready",
  );
  assert.deepEqual(
    await readResult(join(dirname(result.evidencePath), "result.json")),
    result,
  );
  assert.deepEqual(await readResult(join(results, "latest.json")), result);
}

async function startAdapter(
  binary: string,
  root: string,
  module: string,
  env?: NodeJS.ProcessEnv,
) {
  const caseFile = join(root, "case.json");
  const results = join(root, "results");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "adapter-prompt-only",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "adapter fixture\n" } },
      checks: [],
      requiredEvidence: [],
    }),
  );
  const child = Bun.spawn(
    [
      binary,
      "run",
      "--json",
      "--case-file",
      caseFile,
      "--adapter-module",
      module,
      "--project-root",
      root,
      "--results-root",
      results,
      "--runner-build-digest",
      "a".repeat(64),
      "--project-digest",
      "b".repeat(64),
    ],
    { stdout: "pipe", stderr: "pipe", env },
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { child, output };
}

async function adapterOutput(output: Promise<[string, string, number]>) {
  const [stdout, stderr, code] = await output;
  const result: unknown = JSON.parse(stdout);
  assertCliResult(result);
  return { code, stderr, result };
}

async function invokeAdapter(binary: string, root: string, module: string) {
  const started = await startAdapter(binary, root, module);
  return adapterOutput(started.output);
}

export async function runAdapterScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const { code, stderr, result } = await invokeAdapter(
      binary,
      root,
      join(repository, "tests/fixtures/host-adapter.ts"),
    );
    assert.equal(code, 0, stderr);
    await assertRetained(result, join(root, "results"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runForgedMessageScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `export default {
      id: "example.forged-message", model: "deterministic-example", effort: "none",
      run() { return { finalMessage: { toJSON() { return "forged-ready"; } }, complete: true }; }
    };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 2, stderr);
    assert.deepEqual(result.execution, { status: "failed" });
    assert.deepEqual(result.grading, { status: "not_requested" });
    assert.deepEqual(result.task, { verdict: "not_assessed" });
    assert.equal(result.diagnostic?.code, "sevro.host.failed");
    assert(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    assert.deepEqual(evidence.result, result);
    const trial = evidence.trials[0];
    assert(trial);
    assert.equal(trial.observationCompleteness, "unavailable");
    assert.deepEqual(trial.rawResult, {
      source: "example.forged-message",
      path: null,
      sha256: null,
    });
    assert.deepEqual(trial.artifactRefs, []);
    assert.equal(
      await Bun.file(
        join(dirname(result.evidencePath), "trial-1-raw.txt"),
      ).exists(),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runRawMessageScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  const message = "raw \u0000 Καλημέρα 😀\r\n";
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `export default {
      id: "example.rewritten-result", model: "deterministic-example", effort: "none",
      run() { return {
        finalMessage: ${JSON.stringify(message)}, complete: true,
        toJSON() { return { finalMessage: "rewritten", complete: true }; }
      }; }
    };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 0, stderr);
    assert(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    const trial = evidence.trials[0];
    assert(trial);
    assert(trial.rawResult.path);
    const expected = Buffer.from(message, "utf8");
    assert.deepEqual(
      await readFile(fileURLToPath(trial.rawResult.path)),
      expected,
    );
    assert.equal(
      trial.rawResult.sha256,
      createHash("sha256").update(expected).digest("hex"),
    );
    const observation = trial.observations.find(
      (entry) => entry.id === "sevro.observation.final-message",
    );
    assert(observation);
    assert.deepEqual(observation.data, {
      sha256: trial.rawResult.sha256,
      byteLength: expected.byteLength,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runPartialReceiptScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `export default {
      id: "example.partial-result", model: "deterministic-example", effort: "none",
      run() { return {
        executionFailed: true, failureMessage: "controlled adapter failure",
        finalMessage: "partial response", complete: false,
        inputTokens: 12, outputTokens: 3, costUsd: 0.25, usageComplete: true
      }; }
    };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 2, stderr);
    assert.deepEqual(result.execution, { status: "failed" });
    assert.deepEqual(result.grading, { status: "not_requested" });
    assert.deepEqual(result.task, { verdict: "not_assessed" });
    assert.deepEqual(result.diagnostic, {
      code: "sevro.host.failed",
      message: "controlled adapter failure",
    });
    assert(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    const trial = evidence.trials[0];
    assert(trial);
    assert.equal(trial.observationCompleteness, "partial");
    assert.deepEqual(trial.usage, {
      inputTokens: 12,
      outputTokens: 3,
      costUsd: 0.25,
      complete: true,
    });
    assert(trial.rawResult.path);
    assert.equal(
      await readFile(fileURLToPath(trial.rawResult.path), "utf8"),
      "partial response",
    );
    assert.equal(
      trial.rawResult.sha256,
      createHash("sha256").update("partial response").digest("hex"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runBinaryArtifactScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `export default {
      id: "example.binary-artifact", model: "deterministic-example", effort: "none",
      run() {
        const backing = new Uint8Array([99, 0, 255, 128, 10, 13, 42, 98]);
        return { finalMessage: "ready", complete: true,
          artifacts: [{ id: "example.binary", bytes: backing.subarray(1, 7) }] };
      }
    };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 0, stderr);
    assert.deepEqual(result.execution, { status: "completed" });
    assert(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    const trial = evidence.trials[0];
    assert(trial);
    assert.equal(trial.artifactRefs.length, 1);
    const artifact = trial.artifactRefs[0];
    assert(artifact);
    assert.equal(artifact.id, "example.binary");
    assert.deepEqual(
      await readFile(fileURLToPath(artifact.path)),
      Buffer.from([0, 255, 128, 10, 13, 42]),
    );
    assert.equal(
      artifact.sha256,
      "f58452139dc66886579a1e60a27c45ccfca7ff93ac0490c01a0f26e6c3dbed02",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runArtifactLimitsScenario(binary: string) {
  const expressions = [
    '[{ id: { toJSON() { return "example.forged"; } }, bytes: new Uint8Array([1]) }]',
    '[{ id: "example.binary", bytes: [0, 255] }]',
    '[{ id: "../escape", bytes: new Uint8Array([1]) }]',
    'Array.from({ length: 2 }, () => ({ id: "example.binary", bytes: new Uint8Array([1]) }))',
    'Array.from({ length: 33 }, (_, i) => ({ id: "example.artifact-" + i, bytes: new Uint8Array() }))',
    '[{ id: "example.binary", bytes: new Uint8Array(8 * 1024 * 1024 + 1) }]',
    'Array.from({ length: 5 }, (_, i) => ({ id: "example.artifact-" + i, bytes: new Uint8Array(7 * 1024 * 1024) }))',
  ];
  for (const expression of expressions)
    await invalidArtifact(binary, expression);
}

async function invalidArtifact(binary: string, expression: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `export default {
      id: "example.artifact-limits", model: "deterministic-example", effort: "none",
      run() { return { finalMessage: "ready", complete: true, artifacts: ${expression} }; }
    };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 2, stderr);
    assert.deepEqual(result.execution, { status: "failed" });
    assert.deepEqual(result.diagnostic, {
      code: "sevro.host.failed",
      message: "host execution did not complete",
    });
    assert(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    const trial = evidence.trials[0];
    assert(trial);
    assert.deepEqual(trial.artifactRefs, []);
    assert.equal(trial.rawResult.path, null);
    assert.equal(
      (await readdir(dirname(result.evidencePath))).some((name) =>
        name.endsWith(".bin"),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runMaximumArtifactsScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `export default {
      id: "example.artifact-maximum", model: "deterministic-example", effort: "none",
      run() { return {
        finalMessage: "r".repeat(8 * 1024 * 1024), complete: true,
        inputTokens: 12, outputTokens: 3, costUsd: 0.25, usageComplete: true,
        artifacts: Array.from({ length: 4 }, (_, i) => ({
          id: "example.artifact-" + i, bytes: new Uint8Array(8 * 1024 * 1024).fill(i)
        }))
      }; }
    };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 0, stderr);
    assert(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    const trial = evidence.trials[0];
    assert(trial);
    assert.equal(trial.artifactRefs.length, 4);
    for (const [index, artifact] of trial.artifactRefs.entries()) {
      const expected = Buffer.alloc(8 * 1024 * 1024, index);
      const hash = createHash("sha256").update(expected).digest("hex");
      assert.equal(artifact.id, `example.artifact-${index}`);
      assert.equal(artifact.sha256, hash);
      const retained = await readFile(fileURLToPath(artifact.path));
      assert.equal(retained.byteLength, expected.byteLength);
      assert.equal(createHash("sha256").update(retained).digest("hex"), hash);
    }
    assert(trial.rawResult.path);
    const raw = await readFile(fileURLToPath(trial.rawResult.path));
    assert.equal(raw.byteLength, 8 * 1024 * 1024);
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      createHash("sha256")
        .update("r".repeat(8 * 1024 * 1024))
        .digest("hex"),
    );
    assert.deepEqual(trial.usage, {
      inputTokens: 12,
      outputTokens: 3,
      costUsd: 0.25,
      complete: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function cancellationAdapter(root: string) {
  const module = join(root, "adapter.ts");
  await writeFile(
    join(root, "descendant.ts"),
    `
    import { writeFileSync } from "node:fs";
    const root = ${JSON.stringify(root)};
    process.on("SIGTERM", () => {
      writeFileSync(root + "/descendant-stopped.json", JSON.stringify({ pid: process.pid }));
      process.exit(0);
    });
    writeFileSync(root + "/descendant-ready", "ready");
    setInterval(() => {}, 1000);
  `,
  );
  await writeFile(
    module,
    `
    const root = ${JSON.stringify(root)};
    export default {
      id: "example.cooperative-cancellation", model: "deterministic-example", effort: "none",
      async run({ workspace, signal }) {
        if (!(signal instanceof AbortSignal)) {
          await Bun.write(root + "/ready.json", JSON.stringify({ signalProvided: false, workspace }));
          throw new Error("missing actual AbortSignal");
        }
        const child = Bun.spawn([process.execPath, root + "/descendant.ts"], {
          stdin: "ignore", stdout: "ignore", stderr: "inherit"
        });
        let timer;
        try {
          const deadline = Date.now() + 5000;
          while (!(await Bun.file(root + "/descendant-ready").exists())) {
            if (Date.now() >= deadline) throw new Error("descendant did not start");
            await Bun.sleep(10);
          }
          let aborts = 0;
          const cancelled = new Promise((resolve, reject) => {
            const aborted = () => { aborts++; resolve(); };
            if (signal.aborted) aborted();
            else signal.addEventListener("abort", aborted, { once: true });
            timer = setTimeout(() => reject(new Error("adapter never received cancellation")), 5000);
          });
          await Bun.write(root + "/ready.json", JSON.stringify({ signalProvided: true, workspace, child: child.pid }));
          await cancelled;
          await Bun.write(root + "/abort.json", JSON.stringify({ aborts, aborted: signal.aborted, reason: signal.reason }));
          return { finalMessage: "partial before cancellation\\n", complete: false,
            inputTokens: 12, outputTokens: 3, costUsd: 0.25, usageComplete: true };
        } finally {
          clearTimeout(timer);
          child.kill("SIGTERM");
          await Bun.write(root + "/cleanup.json", JSON.stringify({ childExit: await child.exited }));
        }
      }
    };
  `,
  );
  return module;
}

async function awaitAdapterReady(root: string) {
  const marker = join(root, "ready.json");
  const deadline = Date.now() + 6000;
  while (!(await Bun.file(marker).exists())) {
    assert(
      Date.now() < deadline,
      "adapter did not reach its public run callback",
    );
    await Bun.sleep(10);
  }
  return JSON.parse(await readFile(marker, "utf8")) as {
    signalProvided: boolean;
    workspace: string;
    child: number;
  };
}

async function assertCancelledReceipt(result: CliResultData) {
  assert.deepEqual(result.execution, { status: "cancelled" });
  assert.deepEqual(result.grading, { status: "not_requested" });
  assert.deepEqual(result.task, { verdict: "not_assessed" });
  assert.equal(result.diagnostic?.code, "sevro.run.cancelled");
  assert(result.evidencePath);
  const evidence: unknown = JSON.parse(
    await readFile(result.evidencePath, "utf8"),
  );
  assertRunEvidence(evidence);
  assert.deepEqual(evidence.result, result);
  const trial = evidence.trials[0];
  assert(trial);
  assert.equal(trial.observationCompleteness, "partial");
  assert.deepEqual(trial.usage, {
    inputTokens: 12,
    outputTokens: 3,
    costUsd: 0.25,
    complete: true,
  });
  assert(trial.rawResult.path);
  const expected = Buffer.from("partial before cancellation\n");
  assert.deepEqual(
    await readFile(fileURLToPath(trial.rawResult.path)),
    expected,
  );
  assert.equal(
    trial.rawResult.sha256,
    createHash("sha256").update(expected).digest("hex"),
  );
}

export async function runCancellationScenario(
  binary: string,
  signal: "SIGINT" | "SIGTERM" = "SIGINT",
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const started = await startAdapter(
      binary,
      root,
      await cancellationAdapter(root),
    );
    try {
      const ready = await awaitAdapterReady(root);
      assert.equal(
        ready.signalProvided,
        true,
        "HostAdapter.run must receive an actual AbortSignal",
      );
      started.child.kill(signal);
      const { code, stderr, result } = await adapterOutput(started.output);
      assert.equal(code, signal === "SIGINT" ? 130 : 143, stderr);
      await assertCancelledReceipt(result);
      assert.deepEqual(
        JSON.parse(await readFile(join(root, "abort.json"), "utf8")),
        {
          aborts: 1,
          aborted: true,
          reason: signal,
        },
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(root, "cleanup.json"), "utf8")),
        { childExit: 0 },
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(join(root, "descendant-stopped.json"), "utf8"),
        ),
        { pid: ready.child },
      );
      assert.throws(() => process.kill(ready.child, 0), { code: "ESRCH" });
      assert.equal(
        await readFile(join(ready.workspace, "README.md"), "utf8"),
        "adapter fixture\n",
      );
    } finally {
      await started.output;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runNonfiniteConfigurationScenario(binary: string) {
  await runInvalidConfigurationScenario(
    binary,
    '{ "example.invalid": { nested: Number.NaN } }',
  );
}

export async function runDateConfigurationScenario(binary: string) {
  await runInvalidConfigurationScenario(
    binary,
    '{ nested: new Date("2026-01-02T03:04:05.000Z") }',
  );
}

export async function runMapConfigurationScenario(binary: string) {
  await runInvalidConfigurationScenario(
    binary,
    '{ nested: new Map([["setting", "value"]]) }',
  );
}

export async function runClassConfigurationScenario(binary: string) {
  await runInvalidConfigurationScenario(
    binary,
    '{ nested: new (class Setting { value = "kept"; })() }',
  );
}

export async function runUndefinedConfigurationScenario(binary: string) {
  await runInvalidConfigurationScenario(
    binary,
    '{ "example.invalid": { omitted: undefined } }',
  );
}

export async function runAccessorConfigurationScenario(binary: string) {
  await runInvalidConfigurationScenario(
    binary,
    '{ "example.invalid": { get hidden() { return "changed"; } } }',
  );
}

export async function runSymbolConfigurationScenario(binary: string) {
  await runInvalidConfigurationScenario(
    binary,
    '{ "example.setting": "value", [Symbol("hidden")]: "omitted" }',
  );
}

export async function runInvalidMetadataScenario(
  binary: string,
  field: "instrumentation" | "hostCapabilities",
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    const marker = join(root, "executed");
    const declaration =
      field === "instrumentation"
        ? [{ id: "invalid", executionChanging: false }]
        : ["invalid"];
    await writeFile(
      module,
      `export default {
      id:"example.invalid-metadata", model:"deterministic-example", effort:"none",
      ${field}: ${JSON.stringify(declaration)},
      async run() { await Bun.write(${JSON.stringify(marker)}, "executed"); return {finalMessage:"ready",complete:true}; }
    };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 64, stderr);
    assert.deepEqual(result.execution, { status: "not_run" });
    assert.equal(result.diagnostic?.code, "sevro.invocation.invalid");
    assert.equal(result.evidencePath, null);
    assert.deepEqual(result.cases, []);
    assert.equal(await Bun.file(marker).exists(), false);
    assert.equal(
      await Bun.file(join(root, "results/latest.json")).exists(),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function failingBunWrapper(root: string) {
  const bin = join(root, "bin");
  await mkdir(bin);
  const script = join(root, "startup.ts");
  await writeFile(
    script,
    `
    await Bun.write(process.env.SEVRO_TEST_LAUNCH_MARKER, JSON.stringify({ pid: process.pid, bridge: process.argv[2] }));
    console.error("configured Bun wrapper refused startup");
    process.exit(23);
  `,
  );
  await writeFile(
    join(bin, "bun"),
    '#!/bin/sh\nexec "$SEVRO_TEST_BUN" "$SEVRO_TEST_STARTUP_SCRIPT" "$@"\n',
    { mode: 0o700 },
  );
  return {
    ...process.env,
    PATH: bin,
    SEVRO_TEST_BUN: process.execPath,
    SEVRO_TEST_STARTUP_SCRIPT: script,
    SEVRO_TEST_LAUNCH_MARKER: join(root, "launch.json"),
  };
}

export async function runBridgeStartupFailureScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  let launchedDirectory: string | undefined;
  try {
    const started = await startAdapter(
      binary,
      root,
      join(repository, "tests/fixtures/host-adapter.ts"),
      await failingBunWrapper(root),
    );
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      started.child.kill("SIGKILL");
    }, 5000);
    let output: [string, string, number];
    try {
      output = await started.output;
    } finally {
      clearTimeout(watchdog);
    }
    const launch = JSON.parse(
      await readFile(join(root, "launch.json"), "utf8"),
    ) as { pid: number; bridge: string };
    launchedDirectory = dirname(launch.bridge);
    assert.equal(
      timedOut,
      false,
      "CLI must report the exited bridge instead of waiting forever for its connection",
    );
    const { code, stderr, result } = await adapterOutput(
      Promise.resolve(output),
    );
    assert.equal(code, 64, stderr);
    assert.match(stderr, /configured Bun wrapper refused startup/);
    assert.equal(result.diagnostic?.code, "sevro.invocation.invalid");
    assert.match(result.diagnostic.message, /adapter bridge.*23/);
    assert.equal(result.evidencePath, null);
    assert.deepEqual(result.cases, []);
    assert.equal(
      await Bun.file(join(root, "results/latest.json")).exists(),
      false,
    );
    assert.throws(() => process.kill(launch.pid, 0), { code: "ESRCH" });
    await assert.rejects(access(launchedDirectory), { code: "ENOENT" });
  } finally {
    if (launchedDirectory)
      await rm(launchedDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

export async function runUnavailableBunScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const started = await startAdapter(
      binary,
      root,
      join(repository, "tests/fixtures/host-adapter.ts"),
      { ...process.env, PATH: join(root, "empty-bin") },
    );
    const { code, stderr, result } = await adapterOutput(started.output);
    assert.equal(code, 64, stderr);
    assert.deepEqual(result.execution, { status: "not_run" });
    assert.equal(result.diagnostic?.code, "sevro.invocation.invalid");
    assert.match(
      result.diagnostic.message,
      /cannot start TypeScript adapter bridge/,
    );
    assert.equal(result.evidencePath, null);
    assert.deepEqual(result.cases, []);
    assert.equal(
      await Bun.file(join(root, "results/latest.json")).exists(),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runAdapterExitCodeScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `export default {
      id:"sevro.host.synthetic", model:"synthetic-v1", effort:"none",
      run() { process.exitCode = 23; return {finalMessage:"ready",complete:true}; }
    };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 0, stderr);
    await assertRetained(result, join(root, "results"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runAdapterExitHookScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    const marker = join(root, "host.json");
    await writeFile(
      module,
      `process.on("exit", () => { process.exitCode = 23; });
      export default {
        id:"sevro.host.synthetic", model:"synthetic-v1", effort:"none",
        async run({workspace}) {
          await Bun.write(${JSON.stringify(marker)}, JSON.stringify({
            pid:process.pid, bridge:process.argv[1], workspace
          }));
          return {finalMessage:"ready", complete:true};
        }
      };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 23, stderr);
    await assertRetained(result, join(root, "results"));
    const host = JSON.parse(await readFile(marker, "utf8")) as {
      pid: number;
      bridge: string;
      workspace: string;
    };
    assert.throws(() => process.kill(host.pid, 0), { code: "ESRCH" });
    await assert.rejects(access(dirname(host.bridge)), { code: "ENOENT" });
    await assert.rejects(access(host.workspace), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function awaitImportReady(root: string) {
  const marker = join(root, "import-ready.json");
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(marker).exists())) {
    assert(Date.now() < deadline, "adapter did not begin its module import");
    await Bun.sleep(10);
  }
  return JSON.parse(await readFile(marker, "utf8")) as {
    pid: number;
    bridge: string;
  };
}

function killRemainingBridge(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
  }
}

export async function runImportInterruptScenario(
  binary: string,
  signal: "SIGINT" | "SIGTERM" = "SIGINT",
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  const module = join(root, "adapter.ts");
  await writeFile(
    module,
    `
    await Bun.write(${JSON.stringify(join(root, "import-ready.json"))},
      JSON.stringify({pid: process.pid, bridge: process.argv[1]}));
    await new Promise(() => { setInterval(() => {}, 1000); });
    export default {
      id: "example.pending-import", model: "deterministic-example", effort: "none",
      async run() {
        await Bun.write(${JSON.stringify(join(root, "host-called"))}, "called");
        return {finalMessage: "ready", complete: true};
      }
    };
  `,
  );
  const started = await startAdapter(binary, root, module);
  let launch: Awaited<ReturnType<typeof awaitImportReady>> | undefined;
  try {
    launch = await awaitImportReady(root);
    const bridgePid = launch.pid;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      started.child.kill("SIGKILL");
      killRemainingBridge(bridgePid);
    }, 5000);
    started.child.kill(signal);
    let output: Awaited<typeof started.output>;
    try {
      output = await started.output;
    } finally {
      clearTimeout(timer);
    }
    assert.equal(
      timedOut,
      false,
      `${signal} must terminate pending adapter import promptly`,
    );
    const [stdout, stderr, code] = output;
    assert.equal(code, signal === "SIGINT" ? 130 : 143, stderr);
    assert.equal(
      stdout,
      "",
      "import interruption must not publish a run result",
    );
    await assert.rejects(access(join(root, "host-called")), { code: "ENOENT" });
    await assert.rejects(access(join(root, "results")), { code: "ENOENT" });
    assert.throws(() => process.kill(bridgePid, 0), { code: "ESRCH" });
    await assert.rejects(access(dirname(launch.bridge)), { code: "ENOENT" });
  } finally {
    started.child.kill("SIGKILL");
    if (launch) {
      killRemainingBridge(launch.pid);
      await rm(dirname(launch.bridge), { recursive: true, force: true });
    }
    await started.output;
    await rm(root, { recursive: true, force: true });
  }
}

export async function runMalformedAdapterScenario(
  binary: string,
  property: string,
  value: unknown,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    const marker = join(root, "executed");
    await writeFile(
      module,
      `
      const adapter = {
        id:"example.malformed-adapter", model:"example", effort:"none",
        async run() {
          await Bun.write(${JSON.stringify(marker)}, "executed");
          return {finalMessage:"ready",complete:true};
        }
      };
      adapter[${JSON.stringify(property)}] = ${JSON.stringify(value)};
      export default adapter;
    `,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 64, stderr);
    assert.deepEqual(result.execution, { status: "not_run" });
    assert.deepEqual(result.cases, []);
    assert.equal(result.evidencePath, null);
    assert.equal(result.diagnostic?.code, "sevro.invocation.invalid");
    assert.match(result.diagnostic.message, /adapter/);
    await assert.rejects(access(marker), { code: "ENOENT" });
    await assert.rejects(access(join(root, "results")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertInvalidConditionEvidence(
  result: CliResultData,
  root: string,
) {
  assert.deepEqual(result.diagnostic, {
    code: "sevro.instrumentation.mismatch",
    message: "host condition evidence is invalid",
  });
  assert.deepEqual(result.execution, { status: "failed" });
  assert.deepEqual(result.grading, { status: "not_requested" });
  assert.deepEqual(result.task, { verdict: "not_assessed" });
  assert(result.evidencePath);
  const evidence: unknown = JSON.parse(
    await readFile(result.evidencePath, "utf8"),
  );
  assertRunEvidence(evidence);
  assert.deepEqual(evidence.result, result);
  assert.deepEqual(evidence.diagnostic, result.diagnostic);
  const trial = evidence.trials[0];
  assert(trial);
  assert.equal(trial.observationCompleteness, "unavailable");
  assert.deepEqual(trial.rawResult, {
    source: "example.invalid-condition",
    path: null,
    sha256: null,
  });
  assert.deepEqual(trial.usage, {
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    complete: false,
  });
  assert.deepEqual(trial.condition, {
    requested: "passive",
    actual: "unknown",
    appliedInstrumentation: [],
  });
  await assert.rejects(
    access(join(dirname(result.evidencePath), "trial-1-raw.txt")),
    { code: "ENOENT" },
  );
  assert.deepEqual(await readResult(join(root, "results/latest.json")), result);
  assert.deepEqual(
    await readResult(join(dirname(result.evidencePath), "result.json")),
    result,
  );
}

export async function runInvalidConditionScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  const marker = join(root, "workspace.txt");
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `export default {
      id:"example.invalid-condition", model:"example", effort:"none",
      async run({workspace}) {
        await Bun.write(${JSON.stringify(marker)}, workspace);
        return {finalMessage:"ready",complete:true,actualCondition:{private:"private-condition-marker"},
          inputTokens:12,outputTokens:3,costUsd:0.25,usageComplete:true};
      }
    };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 2, stderr);
    await assertInvalidConditionEvidence(result, root);
    assert.equal(stderr.includes("private-condition-marker"), false);
    const workspace = await readFile(marker, "utf8");
    assert.equal(
      await readFile(join(workspace, "README.md"), "utf8"),
      "adapter fixture\n",
    );
  } finally {
    if (await Bun.file(marker).exists())
      await rm(await readFile(marker, "utf8"), {
        recursive: true,
        force: true,
      });
    await rm(root, { recursive: true, force: true });
  }
}

export async function runNullPrototypeConfigurationScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `export default {
        id: "example.configuration-control", model: "deterministic-example", effort: "none",
        configuration: Object.assign(Object.create(null), {
          nested: Object.assign(Object.create(null), {
            enabled: true, amount: 1.25, optional: null, values: ["ready", false, -0]
          })
        }),
        run() { return { finalMessage: "ready", complete: true }; }
      };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 0, stderr);
    assert(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    assert.deepEqual(evidence.configuration.redacted.hostConfiguration, {
      candidate: {
        nested: {
          enabled: true,
          amount: 1.25,
          optional: null,
          values: ["ready", false, 0],
        },
      },
    });
    assert.equal(
      evidence.configuration.digest,
      "8d9f7597ee8ba15fce32a20b9e36b411033e15e0180558f85b3fb81302ed8d99",
    );
    assert.equal(
      evidence.evaluationIdentity.dimensions.configurationDigest,
      evidence.configuration.digest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runConfigurationSerializerGetterScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `export default {
        id: "example.configuration-control", model: "deterministic-example", effort: "none",
        configuration: {
          nested: Object.defineProperty({ value: "kept" }, "toJSON", {
            get() { throw new Error("serializer-called"); }
          })
        },
        run() { return { finalMessage: "ready", complete: true }; }
      };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 0, stderr);
    assert(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    assert.deepEqual(evidence.configuration.redacted.hostConfiguration, {
      candidate: { nested: { value: "kept" } },
    });
    assert.equal(
      evidence.configuration.digest,
      "36047738ff8fd893dcf989199ccdd3d254c3f6c445448bc5e37d4483be98d21f",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runConfigurationSnapshotScenario(binary: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  const expected = {
    "example.setting": [
      "before",
      { enabled: true, value: 1.25, optional: null },
    ],
  };
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `
      const configuration = ${JSON.stringify(expected)};
      Object.defineProperty(configuration, "toJSON", {
        value() { return { "example.setting": "rewritten" }; }
      });
      export default {
        id: "example.configuration-snapshot", model: "deterministic-example", effort: "none", configuration,
        run() {
          configuration["example.setting"] = ["after"];
          return { finalMessage: "ready", complete: true };
        }
      };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 0, stderr);
    assert(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    assert.deepEqual(evidence.configuration.redacted.hostConfiguration, {
      candidate: expected,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runInvalidConfigurationScenario(
  binary: string,
  configuration: string,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-rust-adapter-")),
  );
  try {
    const module = join(root, "adapter.ts");
    const marker = join(root, "executed");
    await writeFile(
      module,
      `export default {
      id: "example.nonfinite-configuration", model: "deterministic-example", effort: "none",
      configuration: ${configuration},
      async run() {
        await Bun.write(${JSON.stringify(marker)}, "executed");
        return { finalMessage: "ready", complete: true };
      }
    };`,
    );
    const { code, stderr, result } = await invokeAdapter(binary, root, module);
    assert.equal(code, 64, stderr);
    assert.deepEqual(result.execution, { status: "not_run" });
    assert.deepEqual(result.cases, []);
    assert.equal(result.evidencePath, null);
    assert.equal(result.diagnostic?.code, "sevro.invocation.invalid");
    assert.equal(await Bun.file(marker).exists(), false);
    await assert.rejects(access(join(root, "results")), { code: "ENOENT" });
    assert.equal(
      await Bun.file(join(root, "results/latest.json")).exists(),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const binary = process.argv[2];
  assert(
    binary,
    "the Cargo integration wrapper must supply its candidate binary",
  );
  switch (process.argv[3]) {
    case "forged-message":
      await runForgedMessageScenario(binary);
      break;
    case "raw-message":
      await runRawMessageScenario(binary);
      break;
    case "nonfinite-configuration":
      await runNonfiniteConfigurationScenario(binary);
      break;
    case "date-configuration":
      await runDateConfigurationScenario(binary);
      break;
    case "map-configuration":
      await runMapConfigurationScenario(binary);
      break;
    case "class-configuration":
      await runClassConfigurationScenario(binary);
      break;
    case "undefined-configuration":
      await runUndefinedConfigurationScenario(binary);
      break;
    case "accessor-configuration":
      await runAccessorConfigurationScenario(binary);
      break;
    case "configuration-snapshot":
      await runConfigurationSnapshotScenario(binary);
      break;
    case "null-prototype-configuration":
      await runNullPrototypeConfigurationScenario(binary);
      break;
    case "configuration-serializer-getter":
      await runConfigurationSerializerGetterScenario(binary);
      break;
    case "symbol-configuration":
      await runSymbolConfigurationScenario(binary);
      break;
    case "invalid-instrumentation":
      await runInvalidMetadataScenario(binary, "instrumentation");
      break;
    case "invalid-capabilities":
      await runInvalidMetadataScenario(binary, "hostCapabilities");
      break;
    case "bridge-startup-failure":
      await runBridgeStartupFailureScenario(binary);
      break;
    case "unavailable-bun":
      await runUnavailableBunScenario(binary);
      break;
    case "adapter-exit-code":
      await runAdapterExitCodeScenario(binary);
      break;
    case "adapter-exit-hook":
      await runAdapterExitHookScenario(binary);
      break;
    case "import-interrupt":
      await runImportInterruptScenario(binary);
      break;
    case "import-terminate":
      await runImportInterruptScenario(binary, "SIGTERM");
      break;
    case "noncallable-adapter-run":
      await runMalformedAdapterScenario(binary, "run", "not a callable");
      break;
    case "invalid-adapter-id":
      await runMalformedAdapterScenario(binary, "id", 42);
      break;
    case "invalid-adapter-model":
      await runMalformedAdapterScenario(binary, "model", null);
      break;
    case "invalid-adapter-effort":
      await runMalformedAdapterScenario(binary, "effort", false);
      break;
    case "invalid-condition":
      await runInvalidConditionScenario(binary);
      break;
    case "partial-receipt":
      await runPartialReceiptScenario(binary);
      break;
    case "binary-artifact":
      await runBinaryArtifactScenario(binary);
      break;
    case "artifact-limits":
      await runArtifactLimitsScenario(binary);
      break;
    case "maximum-artifacts":
      await runMaximumArtifactsScenario(binary);
      break;
    case "cancellation":
      await runCancellationScenario(binary);
      break;
    case "termination":
      await runCancellationScenario(binary, "SIGTERM");
      break;
    default:
      await runAdapterScenario(binary);
  }
}
