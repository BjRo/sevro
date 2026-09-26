import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const adapter = join(import.meta.dir, "fixtures", "host-adapter.ts");
const extensionSource = join(import.meta.dir, "fixtures", "extension.ts");
const digest = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-cli-test-"));
  roots.push(projectRoot);
  const caseFile = join(projectRoot, "case.json");
  const resultsRoot = join(projectRoot, "results");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "answer",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "fixture\n" } },
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    }),
  );
  const args = [
    process.execPath,
    cli,
    "run",
    "--json",
    "--case-file",
    caseFile,
    "--adapter-module",
    adapter,
    "--project-root",
    projectRoot,
    "--results-root",
    resultsRoot,
    "--runner-build-digest",
    digest,
    "--project-digest",
    digest,
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ];
  return { args, caseFile };
}

async function invoke(args: string[], scenario = "pass") {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SEVRO_TEST_SCENARIO: scenario },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, result: JSON.parse(stdout) };
}

test("CLI emits one JSON result and uses the task exit category", async () => {
  const { args } = await fixture();
  const passed = await invoke(args);
  expect(passed.code).toBe(0);
  expect(passed.result.task.verdict).toBe("passed");
  expect(passed.result.exitCode).toBe(0);
  expect(passed.stderr).toBe("");
  expect(
    JSON.parse(await readFile(passed.result.evidencePath, "utf8")).result,
  ).toEqual(passed.result);

  const failed = await invoke(args, "fail");
  expect(failed.code).toBe(1);
  expect(failed.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "failed" },
    exitCode: 1,
  });
});

test("CLI resolves an explicit extension case and retains extension evidence", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify([process.execPath, extensionSource, "lifecycle"]),
  );
  const command = args.filter(
    (part, index) =>
      part !== "--case-file" && args[index - 1] !== "--case-file",
  );
  command.push(
    "--extension-command-file",
    commandFile,
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
  );
  const run = await invoke(command);
  expect(run.code).toBe(0);
  expect(
    run.result.cases[0].trials[0].checks.map(
      (check: { id: string }) => check.id,
    ),
  ).toEqual(["ready", "example.extension.ready"]);
  const evidence = JSON.parse(await readFile(run.result.evidencePath, "utf8"));
  expect(evidence.extension).toMatchObject({
    id: "example.extension",
    protocol: "sevro.extension.v1",
  });
  expect(evidence.trials[0].metrics).toEqual([
    { id: "example.extension.score", value: 1, unit: "ratio" },
  ]);

  const missing = await invoke([...command.slice(0, -1), "missing-case"]);
  expect(missing.code).toBe(64);
  expect(missing.result.evidencePath).toBeNull();
  const ambiguous = await invoke([...command, "--case-file", caseFile]);
  expect(ambiguous.code).toBe(64);
});

test("CLI reports invalid invocation as versioned JSON without a run", async () => {
  const { args, caseFile } = await fixture();
  const invalid = await invoke(
    args.map((arg) => (arg === caseFile ? join(caseFile, "missing") : arg)),
  );
  expect(invalid.code).toBe(64);
  expect(invalid.result).toMatchObject({
    format: "sevro.cli-result.v1",
    execution: { status: "not_run" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
    exitCode: 64,
    evidencePath: null,
    cases: [],
  });
  const badDigest = await invoke(
    args.map((arg) => (arg === digest ? "invalid-digest" : arg)),
  );
  expect(badDigest.code).toBe(64);
  expect(badDigest.result.evidencePath).toBeNull();
});

test("CLI runs shell checks only with explicit isolation roots", async () => {
  if (process.platform !== "darwin") return;
  const { args, caseFile } = await fixture();
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "shell-case",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "fixture\n" } },
      checks: [
        {
          id: "fixture-file",
          grader: "sevro.shell",
          configuration: { run: "test -f README.md" },
        },
      ],
      requiredEvidence: [],
    }),
  );
  const missingIsolation = await invoke(args);
  expect(missingIsolation.code).toBe(64);
  expect(missingIsolation.result.diagnostic.message).toMatch(
    /protected source roots/,
  );
  const isolated = await invoke([
    ...args,
    "--shell-isolation",
    "--protected-root",
    join(caseFile, ".."),
  ]);
  expect(isolated.code).toBe(0);
  expect(isolated.result.cases[0].trials[0].checks[0]).toMatchObject({
    id: "fixture-file",
    status: "passed",
  });
  const relativeRoot = await invoke([
    ...args,
    "--shell-isolation",
    "--protected-root",
    "relative",
  ]);
  expect(relativeRoot.code).toBe(64);
});

test("CLI accepts an independent run-state root", async () => {
  const { args } = await fixture();
  const runStateRoot = await mkdtemp(join(tmpdir(), "sevro-cli-state-"));
  roots.push(runStateRoot);
  const run = await invoke([...args, "--run-state-root", runStateRoot]);
  expect(run.code).toBe(0);
  const active = JSON.parse(
    await readFile(
      join(runStateRoot, "active", `${run.result.runId}.json`),
      "utf8",
    ),
  );
  expect(active.status).toBe("complete");
  expect(active.artifactPath).toBe(run.result.evidencePath);
  const invalid = await invoke([...args, "--run-state-root", "relative"]);
  expect(invalid.code).toBe(64);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`CLI ${signal} cancels host work and retains interruption evidence`, async () => {
    const { args, caseFile } = await fixture();
    const projectRoot = join(caseFile, "..");
    const ready = join(projectRoot, "host-ready");
    const waitingAdapter = join(projectRoot, "waiting-adapter.ts");
    await writeFile(
      waitingAdapter,
      `import { writeFile } from "node:fs/promises";
export default {
  id: "synthetic", model: "synthetic-v1", effort: "none",
  async run({ signal }) {
    await writeFile(${JSON.stringify(ready)}, "ready");
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  },
};
`,
    );
    const command = args.map((value, index) =>
      args[index - 1] === "--adapter-module" ? waitingAdapter : value,
    );
    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    try {
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(ready).exists())) {
        if (Date.now() > deadline) throw new Error("host did not start");
        await Bun.sleep(20);
      }
      proc.kill(signal);
      const [stdout, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      expect(code).toBe(signal === "SIGINT" ? 130 : 143);
      const result = JSON.parse(stdout);
      expect(result.execution.status).toBe("cancelled");
      expect(result.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
      const active = JSON.parse(
        await readFile(
          join(projectRoot, "results", "active", `${result.runId}.json`),
          "utf8",
        ),
      );
      expect(active.status).toBe("interrupted");
      expect(await Bun.file(result.evidencePath).exists()).toBeTrue();
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });
}

test("CLI runs its bundled Codex route with explicit auth and model", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const authFile = join(projectRoot, "auth.json");
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-codex-bin-"));
  roots.push(binRoot);
  const binary = join(binRoot, "codex-wrapper");
  await writeFile(authFile, "test-only-auth\n", { mode: 0o600 });
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-codex\\n'; exit 0; fi
if [ "$1" = sandbox ]; then
  shift
  exec "${installedCodex}" sandbox "$@"
fi
if [ "$1" != exec ]; then exit 99; fi
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-cli"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const withoutAdapter = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  const codexArgs = [
    ...withoutAdapter,
    "--host",
    "codex",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    authFile,
    "--model",
    "synthetic-codex",
    "--effort",
    "low",
  ];
  const run = await invoke(codexArgs);
  expect(run.code).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const trial = JSON.parse(
    await readFile(run.result.cases[0].trials[0].artifactPath, "utf8"),
  );
  expect(trial.evidence.routes[0]).toMatchObject({
    host: "codex",
    model: "synthetic-codex",
  });
  const invalid = await invoke([...args, ...codexArgs.slice(-10)]);
  expect(invalid.code).toBe(64);
});
