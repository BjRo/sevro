import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const adapter = join(import.meta.dir, "fixtures", "host-adapter.ts");
const instrumentedAdapter = join(
  import.meta.dir,
  "fixtures",
  "instrumented-adapter.ts",
);
const semanticAdapter = join(
  import.meta.dir,
  "fixtures",
  "semantic-adapter.ts",
);
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

async function git(root: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [error, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(error);
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

test("CLI dry run retains preparation without calling the host", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify([process.execPath, extensionSource, "lifecycle-artifact"]),
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
    "--dry",
  );
  const run = await invoke(command, "fail");
  expect(run.code).toBe(0);
  expect(run.result).toMatchObject({
    execution: { status: "not_run" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
  });
  expect(run.result.cases[0].trials[0].checks).toEqual([]);
  const evidence = JSON.parse(await readFile(run.result.evidencePath, "utf8"));
  expect(evidence.trials[0].executionMode).toBe("dry");
  expect(evidence.trials[0].metrics).toEqual([]);
  const [artifact] = evidence.trials[0].artifactRefs;
  expect(await readFile(new URL(artifact.path), "utf8")).toBe(
    "prepared data\n",
  );
});

test("CLI reports unavailable required host evidence", async () => {
  const { args, caseFile } = await fixture();
  const definition = JSON.parse(await readFile(caseFile, "utf8"));
  definition.requiredEvidence = ["darrow.activation"];
  await writeFile(caseFile, JSON.stringify(definition));
  const missing = await invoke(args);
  expect(missing.code).toBe(4);
  expect(missing.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "unavailable" },
    task: { verdict: "not_assessed" },
  });
  const complete = await invoke(args, "observation");
  expect(complete.code).toBe(0);
  const evidence = JSON.parse(
    await readFile(complete.result.evidencePath, "utf8"),
  );
  expect(evidence.trials[0].observations[1]).toMatchObject({
    id: "darrow.activation",
    source: "sevro.host.synthetic",
    completeness: "complete",
  });
});

test("CLI runs semantic checks through an explicit grader route", async () => {
  const { args, caseFile } = await fixture();
  const definition = JSON.parse(await readFile(caseFile, "utf8"));
  definition.checks.push({
    id: "semantic-ready",
    grader: "sevro.semantic",
    configuration: { proposition: "The response promises readiness." },
  });
  await writeFile(caseFile, JSON.stringify(definition));
  const missing = await invoke(args);
  expect(missing.code).toBe(64);
  expect(missing.result.diagnostic.message).toMatch(/explicit semantic host/);
  const command = [...args, "--semantic-adapter-module", semanticAdapter];
  const passed = await invoke(command);
  expect(passed.code).toBe(0);
  const evidence = JSON.parse(
    await readFile(passed.result.evidencePath, "utf8"),
  );
  expect(evidence.routes.map((route: { role: string }) => route.role)).toEqual([
    "candidate",
    "semantic",
  ]);
  expect(passed.result.cases[0].trials[0].checks[1]).toMatchObject({
    id: "semantic-ready",
    status: "passed",
  });
  const failed = await invoke(command, "semantic-fail");
  expect(failed.code).toBe(1);
  const malformed = await invoke(command, "semantic-malformed");
  expect(malformed.code).toBe(3);
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

test("CLI selects an advertised extension task policy explicitly", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify([process.execPath, extensionSource, "lifecycle-policy"]),
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
  const defaultRun = await invoke(command);
  expect(defaultRun.code).toBe(1);
  const selected = await invoke([
    ...command,
    "--task-verdict-policy",
    "example.policy",
  ]);
  expect(selected.code).toBe(0);
  expect(selected.result.cases[0].trials[0].checks[0].status).toBe("failed");
  const evidence = JSON.parse(
    await readFile(selected.result.evidencePath, "utf8"),
  );
  const defaultEvidence = JSON.parse(
    await readFile(defaultRun.result.evidencePath, "utf8"),
  );
  expect(evidence.evaluationIdentity.digest).not.toBe(
    defaultEvidence.evaluationIdentity.digest,
  );
  expect(evidence.extension.replacements.taskVerdictPolicy).toBe(
    "example.policy",
  );
  expect(evidence.trials[0].taskVerdictPolicy.recommendation).toBe("passed");
  const rejected = await invoke([
    ...args,
    "--task-verdict-policy",
    "example.policy",
  ]);
  expect(rejected.code).toBe(64);
});

test("CLI replaces a selected built-in grader through the extension", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify([
      process.execPath,
      extensionSource,
      "lifecycle-replace-regex",
    ]),
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
  expect((await invoke(command)).code).toBe(1);
  const selected = await invoke([
    ...command,
    "--replace-builtin-grader",
    "sevro.regex",
  ]);
  expect(selected.code).toBe(0);
  expect(selected.result.cases[0].trials[0].checks).toEqual([
    expect.objectContaining({
      id: "example.extension.ready",
      status: "passed",
    }),
  ]);
  const evidence = JSON.parse(
    await readFile(selected.result.evidencePath, "utf8"),
  );
  expect(evidence.graders.replacedDefaults).toEqual(["sevro.regex"]);
  expect(
    (await invoke([...command, "--replace-builtin-grader", "sevro.schema"]))
      .code,
  ).toBe(64);
  expect(
    (
      await invoke([
        ...command,
        "--replace-builtin-grader",
        "sevro.regex",
        "--replace-builtin-grader",
        "sevro.regex",
      ])
    ).code,
  ).toBe(64);
});

test("CLI negotiates and records enforced host instrumentation", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify([
      process.execPath,
      extensionSource,
      "lifecycle-instrumentation-supported",
    ]),
  );
  const command = args.filter(
    (part, index) =>
      part !== "--case-file" && args[index - 1] !== "--case-file",
  );
  command[command.indexOf("--adapter-module") + 1] = instrumentedAdapter;
  command[command.indexOf("--condition") + 1] = "enforced";
  command.push(
    "--extension-command-file",
    commandFile,
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
  );
  const enforced = await invoke(command);
  expect(enforced.code).toBe(0);
  const evidence = JSON.parse(
    await readFile(enforced.result.evidencePath, "utf8"),
  );
  expect(evidence.condition).toMatchObject({
    requested: "enforced",
    actual: "enforced",
    requestedInstrumentation: [
      { id: "example.extension.guard", configuration: {} },
    ],
    appliedInstrumentation: [
      { id: "example.extension.guard", configuration: {} },
    ],
  });
  const passive = [...command];
  passive[passive.indexOf("--condition") + 1] = "passive";
  const rejected = await invoke(passive);
  expect(rejected.code).toBe(64);
  expect(rejected.result.evidencePath).toBeNull();
});

test("CLI mounts only declared preparation source files", async () => {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const commandFile = join(projectRoot, "extension-command.json");
  const sourceRoot = join(projectRoot, "sources");
  const sourceFile = join(sourceRoot, "data.txt");
  const mapFile = join(projectRoot, "source-map.json");
  await Bun.write(sourceFile, "prepared data\n");
  await writeFile(
    commandFile,
    JSON.stringify([
      process.execPath,
      extensionSource,
      "lifecycle-source-artifact",
    ]),
  );
  await writeFile(
    mapFile,
    JSON.stringify({ "input-data": pathToFileURL(sourceFile).href }),
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
    "--case-source-root",
    sourceRoot,
    "--case-source-map-file",
    mapFile,
  );
  const run = await invoke(command);
  expect(run.code).toBe(0);
  const evidence = JSON.parse(await readFile(run.result.evidencePath, "utf8"));
  const [artifact] = evidence.trials[0].artifactRefs;
  expect(await readFile(new URL(artifact.path), "utf8")).toBe(
    "prepared data\n",
  );

  await writeFile(
    mapFile,
    JSON.stringify({ "input-data": pathToFileURL(commandFile).href }),
  );
  const escaped = await invoke(command);
  expect(escaped.code).toBe(64);
  expect(escaped.result.evidencePath).toBeNull();
  expect(escaped.result.diagnostic.message).toMatch(
    /escapes its declared root/,
  );
});

test("CLI executes a declared repository fixture", async () => {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const sourceRoot = join(projectRoot, "sources");
  const repository = join(sourceRoot, "example");
  const mapFile = join(projectRoot, "source-map.json");
  await mkdir(repository, { recursive: true });
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, "README.md"), "repository fixture\n");
  await git(repository, "add", "README.md");
  await git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Create fixture",
  );
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "repository-case",
      prompt: "Return ready.",
      fixture: { sourceRef: "fixture-repo" },
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
  await writeFile(
    mapFile,
    JSON.stringify({ "fixture-repo": pathToFileURL(repository).href }),
  );
  const run = await invoke([
    ...args,
    "--case-source-root",
    sourceRoot,
    "--case-source-map-file",
    mapFile,
  ]);
  expect(run.code).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const missingMap = await invoke(args);
  expect(missingMap.code).toBe(64);

  const commandFile = join(projectRoot, "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify([process.execPath, extensionSource, "lifecycle-repository"]),
  );
  const extensionCommand = args.filter(
    (part, index) =>
      part !== "--case-file" && args[index - 1] !== "--case-file",
  );
  const extended = await invoke([
    ...extensionCommand,
    "--extension-command-file",
    commandFile,
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
    "--case-source-root",
    sourceRoot,
    "--case-source-map-file",
    mapFile,
  ]);
  expect(extended.code).toBe(0);
  expect(
    extended.result.cases[0].trials[0].checks.map(
      (check: { id: string }) => check.id,
    ),
  ).toEqual(["ready", "example.extension.ready"]);
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
  const semanticEvent = JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        checks: [
          {
            id: "semantic-ready",
            verdict: "pass",
            reason: "Ready is stated",
          },
        ],
      }),
    },
  });
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
for arg in "$@"; do
  if [ "$arg" = synthetic-judge ]; then
    printf '%s\\n' '${semanticEvent}'
    printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    exit 0
  fi
done
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

  const definition = JSON.parse(await readFile(caseFile, "utf8"));
  definition.checks.push({
    id: "semantic-ready",
    grader: "sevro.semantic",
    configuration: { proposition: "The response promises readiness." },
  });
  await writeFile(caseFile, JSON.stringify(definition));
  const semanticArgs = [
    ...args,
    "--semantic-host",
    "codex",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    authFile,
    "--semantic-model",
    "synthetic-judge",
    "--semantic-effort",
    "low",
  ];
  const semanticRun = await invoke(semanticArgs);
  expect(semanticRun.code).toBe(0);
  const semanticEvidence = JSON.parse(
    await readFile(semanticRun.result.evidencePath, "utf8"),
  );
  expect(semanticEvidence.routes[1]).toMatchObject({
    role: "semantic",
    host: "codex",
    model: "synthetic-judge",
  });
  expect(semanticEvidence.trials[0].artifactRefs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "sevro.semantic.sevro.codex.events" }),
    ]),
  );
  const conflicting = await invoke([
    ...semanticArgs,
    "--semantic-adapter-module",
    semanticAdapter,
  ]);
  expect(conflicting.code).toBe(64);
});
