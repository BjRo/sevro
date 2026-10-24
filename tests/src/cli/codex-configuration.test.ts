import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defined,
  expectUnknown,
  fixtureCase,
  parseRunEvidence,
  record,
} from "../../fixtures/assertions";
import {
  createFixture,
  git,
  installLinuxCodexHelper,
  invoke,
  isolatedNativeHost,
} from "../../fixtures/cli-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const fixture = createFixture(roots);

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("CLI imports only the Codex limit from its separate configuration root", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const configRoot = await temporaryFixture(
    join(tmpdir(), "sevro-config-root-"),
  );
  const binRoot = await temporaryFixture(join(tmpdir(), "sevro-config-bin-"));

  const binary = join(binRoot, "codex-wrapper");
  await installLinuxCodexHelper(binary, installedCodex);
  const authFile = join(projectRoot, "auth.json");
  await mkdir(join(configRoot, ".codex"));
  await mkdir(join(projectRoot, ".codex"));
  await writeFile(
    join(projectRoot, ".codex", "config.toml"),
    "[agents]\nmax_concurrent_threads_per_session = 3\n",
  );
  const configFile = join(configRoot, ".codex", "config.toml");
  await writeFile(
    configFile,
    'model = "unrelated-config-marker"\n[agents]\nmax_concurrent_threads_per_session = 7\n',
  );
  await writeFile(authFile, "test-only-auth\n", { mode: 0o600 });
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-codex\\n'; exit 0; fi
if [ "$1" = sandbox ]; then shift; exec "${installedCodex}" sandbox "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
grep -q '^max_concurrent_threads_per_session = 7$' "$CODEX_HOME/config.toml" || exit 98
if grep -q unrelated-config-marker "$CODEX_HOME/config.toml"; then exit 97; fi
printf '%s\\n' '{"type":"thread.started","thread_id":"config-root-cli"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    { mode: 0o700 },
  );
  const withoutAdapter = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  const selectedArgs = [
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
    "--config-root",
    configRoot,
  ];
  const run = await invoke(selectedArgs);
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expectUnknown(evidence.configuration.redacted.hostConfiguration).toEqual({
    candidate: {
      "sevro.codex.agent-concurrency-limit": 7,
      "sevro.host.executable": await realpath(binary),
    },
  });
  expect(JSON.stringify(evidence)).not.toContain("unrelated-config-marker");
  await writeFile(
    configFile,
    "[agents]\nmax_concurrent_threads_per_session = 9\n",
  );
  const changed = await invoke([...selectedArgs, "--dry"]);
  expect(changed.code, JSON.stringify(changed.result.diagnostic)).toBe(0);
  const changedEvidence = parseRunEvidence(
    await readFile(defined(changed.result.evidencePath), "utf8"),
  );
  expectUnknown(
    changedEvidence.configuration.redacted.hostConfiguration,
  ).toEqual({
    candidate: {
      "sevro.codex.agent-concurrency-limit": 9,
      "sevro.host.executable": await realpath(binary),
    },
  });
  await writeFile(
    configFile,
    "[agents]\nmax_concurrent_threads_per_session = 7\n",
  );
  const restored = await invoke([...selectedArgs, "--dry"]);
  expect(restored.code, JSON.stringify(restored.result.diagnostic)).toBe(0);
  const restoredEvidence = parseRunEvidence(
    await readFile(defined(restored.result.evidencePath), "utf8"),
  );
  expect(restoredEvidence.evaluationIdentity.digest).not.toBe(
    changedEvidence.evaluationIdentity.digest,
  );
});

test("CLI isolates a separate configuration repository and its linked worktree", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const { args, caseFile } = await fixture();
  const configRoot = await temporaryFixture(
    join(tmpdir(), "sevro-config-repo-"),
  );
  const worktreeParent = await temporaryFixture(
    join(tmpdir(), "sevro-config-worktree-"),
  );

  const linked = join(worktreeParent, "linked");
  await git(configRoot, "init", "-q");
  await writeFile(
    join(configRoot, "secret.txt"),
    "configuration-private-marker\n",
  );
  await git(configRoot, "add", "secret.txt");
  await git(
    configRoot,
    "-c",
    "user.name=Sevro Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "chore: initialize configuration",
  );
  await git(configRoot, "worktree", "add", "-qb", "linked", linked);
  const definition = fixtureCase();
  definition.checks.push(
    ...[configRoot, linked].map((root, index) => ({
      id: `configuration-private-${index}`,
      grader: "sevro.shell",
      configuration: { run: `! cat '${root}/secret.txt' >/dev/null 2>&1` },
    })),
  );
  await writeFile(caseFile, JSON.stringify(definition));
  const run = await invoke([
    ...args,
    "--config-root",
    configRoot,
    "--shell-isolation",
  ]);
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  expectUnknown(
    defined(defined(run.result.cases[0]).trials[0])
      .checks.filter((check: { id: string }) =>
        check.id.startsWith("configuration-private-"),
      )
      .map((check: { status: string }) => check.status),
  ).toEqual(["passed", "passed"]);
});

test("CLI refuses a dangling Codex configuration link before execution", async () => {
  const { args, caseFile } = await fixture();
  const configRoot = join(caseFile, "..");
  await mkdir(join(configRoot, ".codex"));
  await symlink(
    join(configRoot, "missing.toml"),
    join(configRoot, ".codex", "config.toml"),
  );
  const withoutAdapter = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  const run = await invoke([
    ...withoutAdapter,
    "--dry",
    "--host",
    "codex",
    "--codex-bin",
    process.execPath,
    "--codex-auth-file",
    caseFile,
    "--model",
    "synthetic-codex",
    "--effort",
    "low",
  ]);
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
  expect(defined(run.result.diagnostic).message).toContain(
    "Cannot read Codex configuration",
  );
});

test("CLI distinguishes absent Codex configuration from a dangling directory link", async () => {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const directory = join(projectRoot, ".codex");
  const withoutAdapter = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  const selectedArgs = [
    ...withoutAdapter,
    "--dry",
    "--host",
    "codex",
    "--codex-bin",
    process.execPath,
    "--codex-auth-file",
    caseFile,
    "--model",
    "synthetic-codex",
    "--effort",
    "low",
  ];
  for (const emptyDirectory of [false, true]) {
    if (emptyDirectory) await mkdir(directory);
    const run = await invoke(selectedArgs);
    expect(run.code).toBe(0);
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    expectUnknown(
      record(evidence.configuration.redacted.hostConfiguration).candidate,
    ).toEqual({
      "sevro.codex.agent-concurrency-limit": null,
      "sevro.host.executable": await realpath(process.execPath),
    });
  }
  await rm(directory, { recursive: true });
  await symlink(join(projectRoot, "missing-directory"), directory);
  const run = await invoke(selectedArgs);
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
  expect(defined(run.result.diagnostic).message).toContain(
    join(directory, "config.toml"),
  );
});

test("CLI rejects an explicitly empty configuration root", async () => {
  const { args } = await fixture();
  for (const supplied of [["--config-root", ""], ["--config-root="]]) {
    const run = await invoke([...args, "--dry", ...supplied]);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
  }
});

test("CLI retains Codex defaults and the configured limit for every role", async () => {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const definition = fixtureCase();
  definition.fixture = {
    kind: "generated",
    commits: [
      { message: "chore: initialize", files: { "README.md": "fixture\n" } },
    ],
  };
  definition.checks.push({
    id: "meaning",
    grader: "sevro.semantic",
    configuration: { proposition: "The response promises readiness." },
  });
  await writeFile(caseFile, JSON.stringify(definition));
  const withoutAdapter = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  const selectedArgs = [
    ...withoutAdapter,
    "--dry",
    "--host",
    "codex",
    "--codex-bin",
    process.execPath,
    "--codex-auth-file",
    caseFile,
    "--model",
    "synthetic-codex",
    "--effort",
    "low",
    "--semantic-host",
    "codex",
    "--semantic-model",
    "synthetic-judge",
    "--semantic-effort",
    "medium",
    "--advisory-host",
    "codex",
    "--advisory-model",
    "synthetic-reviewer",
    "--advisory-effort",
    "high",
  ];
  const configFile = join(projectRoot, ".codex", "config.toml");
  await mkdir(join(projectRoot, ".codex"));
  for (const source of [
    undefined,
    "",
    "[agents]\nenabled = true\n",
    "[agents]\nmax_concurrent_threads_per_session = 8\n",
  ]) {
    if (source === undefined) await rm(configFile, { force: true });
    else await writeFile(configFile, source);
    const run = await invoke(selectedArgs);
    expect(run.code, JSON.stringify(run.result.diagnostic)).toBe(0);
    expect(run.result.execution.status).toBe("not_run");
    expect(run.result.task.verdict).toBe("not_assessed");
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    const limit = source?.includes("= 8") ? 8 : null;
    expectUnknown(evidence.configuration.redacted.hostConfiguration).toEqual({
      candidate: {
        "sevro.codex.agent-concurrency-limit": limit,
        "sevro.host.executable": await realpath(process.execPath),
      },
      semantic: {
        "sevro.codex.agent-concurrency-limit": limit,
        "sevro.host.executable": await realpath(process.execPath),
      },
      advisory: {
        "sevro.codex.agent-concurrency-limit": limit,
        "sevro.host.executable": await realpath(process.execPath),
      },
    });
  }
});

test("CLI rejects malformed Codex settings and unusable configuration roots", async () => {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const configFile = join(projectRoot, ".codex", "config.toml");
  await mkdir(join(projectRoot, ".codex"));
  const withoutAdapter = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  const selectedArgs = [
    ...withoutAdapter,
    "--dry",
    "--host",
    "codex",
    "--codex-bin",
    process.execPath,
    "--codex-auth-file",
    caseFile,
    "--model",
    "synthetic-codex",
    "--effort",
    "low",
  ];
  const invalid = [
    "[agents",
    "agents = 5",
    ...["0", "-1", "1.5", "5.0", '"5"', "true", "9007199254740992"].map(
      (value) => `[agents]\nmax_concurrent_threads_per_session = ${value}\n`,
    ),
  ];
  for (const source of invalid) {
    await writeFile(configFile, source);
    const run = await invoke(selectedArgs);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
    expect(defined(run.result.diagnostic).message).toContain(configFile);
  }
  await rm(configFile);
  await mkdir(configFile);
  const unreadable = await invoke(selectedArgs);
  expect(unreadable.code).toBe(64);
  expect(defined(unreadable.result.diagnostic).message).toContain(
    "Cannot read Codex configuration",
  );
  for (const root of ["relative", caseFile, join(projectRoot, "absent")]) {
    const run = await invoke([...args, "--dry", "--config-root", root]);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
  }
});
