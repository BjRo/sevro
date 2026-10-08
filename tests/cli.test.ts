import { expectUnknown } from "./fixtures/assertions";
import {
  arrayContaining,
  checkoutRunner,
  defined,
  fixtureCase,
  objectContaining,
  parseCheckpoint,
  parseCliResult,
  parseJson,
  parseRecord,
  parseRunEvidence,
  parseTrial,
  record,
  string,
} from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionFixtureCommand } from "./fixtures/extension-command";
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
const advisoryAdapter = join(
  import.meta.dir,
  "fixtures",
  "advisory-adapter.ts",
);
const extensionSource = join(import.meta.dir, "fixtures", "extension.ts");
const digest = "a".repeat(64);
const fixtureExtensionCommand = extensionFixtureCommand();
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
  await writeFile(caseFile, JSON.stringify(fixtureCase()));
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
async function invoke(
  args: string[],
  scenario = "pass",
  environment: Record<string, string> = {},
) {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SEVRO_TEST_SCENARIO: scenario, ...environment },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, result: parseCliResult(stdout) };
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
  expectUnknown(
    parseRunEvidence(
      await readFile(defined(passed.result.evidencePath), "utf8"),
    ).result,
  ).toEqual(passed.result);
  const failed = await invoke(args, "fail");
  expect(failed.code, JSON.stringify(failed.result.diagnostic)).toBe(1);
  expect(failed.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "failed" },
    exitCode: 1,
  });
});
test("CLI supplies a canonical candidate workspace", async () => {
  const { args, caseFile } = await fixture();
  const host = join(caseFile, "..", "canonical-host.ts");
  await writeFile(
    host,
    `import { realpath } from "node:fs/promises";
export default {
  id: "sevro.host.synthetic", model: "synthetic-v1", effort: "none",
  async run({ workspace }) {
    return {
      finalMessage: "ready", complete: true,
      observations: [{ id: "sevro.test.workspace", source: "sevro.host.synthetic", completeness: "complete", data: { path: workspace, canonicalPath: await realpath(workspace) } }],
    };
  },
};\n`,
  );
  args[args.indexOf("--adapter-module") + 1] = host;
  const run = await invoke(args);
  expect(run.code, run.stderr).toBe(0);
  expect(run.result.execution.status).toBe("completed");
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const observation = defined(evidence.trials[0]).observations.find(
    (item: { id: string }) => item.id === "sevro.test.workspace",
  );
  expect(defined(observation).data.path).toBeString();
  expect(defined(observation).data.path).toBe(
    defined(observation).data.canonicalPath,
  );
});
function lockedFixturePath(location: string) {
  return location === "child" ? 'join(workspace, "locked")' : "workspace";
}
function lockedFixtureMode(location: string) {
  return location === "readable root" ? "0o500" : "0o000";
}
function availableNativeCodex() {
  return process.platform === "darwin" ? Bun.which("codex") : null;
}
function expectedContinuationState(scenario: string) {
  return {
    completeness: scenario === "unmeasured-worktree" ? "partial" : "complete",
    data: {
      preFollowUpWorktreeUnchanged:
        scenario === "unmeasured-worktree"
          ? null
          : scenario !== "changed-worktree",
    },
  };
}
test.each(["child", "root", "readable root"])(
  "CLI removes a permission-locked candidate directory (%s)",
  async (location) => {
    const { args, caseFile } = await fixture();
    const host = join(caseFile, "..", "locked-host.ts");
    const external = join(caseFile, "..", "external");
    await mkdir(external);
    const externalFile = join(external, "retained.txt");
    await writeFile(externalFile, "external retained\n");
    await chmod(externalFile, 0o400);
    await chmod(external, 0o500);
    const externalMode = (await stat(external)).mode;
    const externalFileMode = (await stat(externalFile)).mode;
    await writeFile(
      host,
      `import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default {
  id: "sevro.host.synthetic", model: "synthetic-v1", effort: "none",
  async run({ workspace }) {
    const locked = ${lockedFixturePath(location)};
    if (locked !== workspace) await mkdir(locked);
    await writeFile(join(locked, "value.txt"), "candidate output\\n");
    await symlink(${JSON.stringify(external)}, join(locked, "external"), "junction");
    await chmod(locked, ${lockedFixtureMode(location)});
    return {
      finalMessage: "ready", complete: true,
      observations: [{ id: "sevro.test.workspace", source: "sevro.host.synthetic", completeness: "complete", data: { path: workspace } }],
    };
  },
};\n`,
    );
    args[args.indexOf("--adapter-module") + 1] = host;
    let workspace = "";
    try {
      const run = await invoke(args);
      expect(run.code, run.stderr).toBe(0);
      const evidence = parseRunEvidence(
        await readFile(defined(run.result.evidencePath), "utf8"),
      );
      expectUnknown(evidence.result).toEqual(run.result);
      workspace = string(
        defined(
          defined(evidence.trials[0]).observations.find(
            (item: { id: string }) => item.id === "sevro.test.workspace",
          ),
        ).data.path,
      );
      expect(workspace).toBeString();
      expect(workspace.length).toBeGreaterThan(0);
      expect(existsSync(workspace)).toBe(false);
      expect((await stat(external)).mode).toBe(externalMode);
      expect((await stat(externalFile)).mode).toBe(externalFileMode);
      expect(await readFile(externalFile, "utf8")).toBe("external retained\n");
    } finally {
      if (workspace && existsSync(workspace)) {
        await chmod(workspace, 0o700);
        if (existsSync(join(workspace, "locked")))
          await chmod(join(workspace, "locked"), 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
      await chmod(external, 0o700);
      await chmod(externalFile, 0o600);
    }
  },
);
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
  const checkout = resolve(import.meta.dir, "..");
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
test("CLI dry run retains preparation without calling the host", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-artifact"),
    ),
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
  expectUnknown(defined(defined(run.result.cases[0]).trials[0]).checks).toEqual(
    [],
  );
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(defined(evidence.trials[0]).executionMode).toBe("dry");
  expectUnknown(defined(evidence.trials[0]).metrics).toEqual([]);
  const [artifact] = defined(evidence.trials[0]).artifactRefs;
  expect(await readFile(new URL(defined(artifact).path), "utf8")).toBe(
    "prepared data\n",
  );
});
test("CLI reports unavailable required host evidence", async () => {
  const { args, caseFile } = await fixture();
  const definition = fixtureCase();
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
  const evidence = parseRunEvidence(
    await readFile(defined(complete.result.evidencePath), "utf8"),
  );
  expect(defined(defined(evidence.trials[0]).observations[1])).toMatchObject({
    id: "darrow.activation",
    source: "sevro.host.synthetic",
    completeness: "complete",
  });
});
test("CLI runs semantic checks through an explicit grader route", async () => {
  const { args, caseFile } = await fixture();
  const definition = fixtureCase();
  definition.checks.push({
    id: "semantic-ready",
    grader: "sevro.semantic",
    configuration: { proposition: "The response promises readiness." },
  });
  await writeFile(caseFile, JSON.stringify(definition));
  const missing = await invoke(args);
  expect(missing.code).toBe(64);
  expect(defined(missing.result.diagnostic).message).toMatch(
    /explicit semantic host/,
  );
  const command = [...args, "--semantic-adapter-module", semanticAdapter];
  const passed = await invoke(command);
  expect(passed.code).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(passed.result.evidencePath), "utf8"),
  );
  expectUnknown(
    evidence.routes.map((route: { role: string }) => route.role),
  ).toEqual(["candidate", "semantic"]);
  expect(
    defined(defined(defined(passed.result.cases[0]).trials[0]).checks[1]),
  ).toMatchObject({
    id: "semantic-ready",
    status: "passed",
  });
  const failed = await invoke(command, "semantic-fail");
  expect(failed.code).toBe(1);
  const malformed = await invoke(command, "semantic-malformed");
  expect(malformed.code).toBe(3);
});
test("CLI selects an advisory route and retains its independent assessment", async () => {
  const { args, caseFile } = await fixture();
  const definition = fixtureCase();
  definition.fixture = {
    kind: "generated",
    commits: [
      {
        message: "Add baseline",
        files: {
          "README.md": "fixture\n",
          "app.ts": "export const value = 1;\n",
          ".agents/condition.txt": "private condition\n",
        },
      },
    ],
    files: { "app.ts": "export const value = 2;\n" },
  };
  await writeFile(caseFile, JSON.stringify(definition));
  const command = [...args, "--advisory-adapter-module", advisoryAdapter];
  const passed = await invoke(command);
  expect(passed.code).toBe(0);
  expect(passed.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(defined(passed.result.evidencePath), "utf8"),
  );
  expect(defined(evidence.routes[1])).toMatchObject({
    role: "advisory",
    host: "sevro.host.advisory-synthetic",
  });
  expect(defined(evidence.trials[0]).advisoryReview).toMatchObject({
    status: "completed",
    assessment: { verdict: "fail", overallScore: 2 },
  });
  const plain = await invoke(args);
  const plainEvidence = parseRunEvidence(
    await readFile(defined(plain.result.evidencePath), "utf8"),
  );
  expect(evidence.evaluationIdentity.digest).not.toBe(
    plainEvidence.evaluationIdentity.digest,
  );
  const conflicting = await invoke([...command, "--advisory-host", "codex"]);
  expect(conflicting.code).toBe(64);
  const invalid = await invoke([...args, "--advisory-exclude", "private.txt"]);
  expect(invalid.code).toBe(64);
});
test("CLI resolves an explicit extension case and retains extension evidence", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(fixtureExtensionCommand(extensionSource, "lifecycle")),
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
  expectUnknown(
    defined(defined(run.result.cases[0]).trials[0]).checks.map(
      (check: { id: string }) => check.id,
    ),
  ).toEqual(["ready", "example.extension.ready"]);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(evidence.extension).toMatchObject({
    id: "example.extension",
    protocol: "sevro.extension.v1",
  });
  expectUnknown(defined(evidence.trials[0]).metrics).toEqual([
    { id: "example.extension.score", value: 1, unit: "ratio" },
  ]);
  const missing = await invoke([...command.slice(0, -1), "missing-case"]);
  expect(missing.code).toBe(64);
  expect(missing.result.evidencePath).toBeNull();
  const ambiguous = await invoke([...command, "--case-file", caseFile]);
  expect(ambiguous.code).toBe(64);
});
test("CLI supplies the selected candidate route during extension resolution", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-host-route"),
    ),
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
  const run = await invoke(command, "echo-prompt");
  expect(run.code, run.stdout + run.stderr).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const response = await readFile(
    new URL(defined(defined(evidence.trials[0]).rawResult.path)),
    "utf8",
  );
  expectUnknown(parseJson(response)).toEqual({
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    capabilities: [],
  });
  expect(defined(evidence.extension).capabilities).toContain(
    "sevro.case.host-route",
  );
});
test("CLI retains redacted extension configuration with its identity", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  const privateFile = join(caseFile, "..", "private-configuration.json");
  const redactedFile = join(caseFile, "..", "redacted-configuration.json");
  await writeFile(
    commandFile,
    JSON.stringify(fixtureExtensionCommand(extensionSource, "lifecycle")),
  );
  await writeFile(
    privateFile,
    JSON.stringify({
      label: "condition",
      secret: "private-configuration-marker",
    }),
  );
  await writeFile(
    redactedFile,
    JSON.stringify({ label: "condition", secretPresent: true }),
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
    "--extension-configuration-file",
    privateFile,
    "--extension-redacted-configuration-file",
    redactedFile,
    "--case-id",
    "extension-case",
  );
  const run = await invoke(command);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const text = await readFile(defined(run.result.evidencePath), "utf8");
  const evidence = parseRunEvidence(text);
  expectUnknown(evidence.configuration.redacted.extensionConfiguration).toEqual(
    {
      label: "condition",
      secretPresent: true,
    },
  );
  expect(evidence.configuration.redacted.extensionConfigurationDigest).toBe(
    defined(evidence.extension).configurationDigest,
  );
  expect(text).not.toContain("private-configuration-marker");
});
test("CLI text output names domain outcomes apart from the task verdict", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-domain-outcome"),
    ),
  );
  const command = args.filter(
    (part, index) =>
      part !== "--case-file" &&
      args[index - 1] !== "--case-file" &&
      part !== "--json",
  );
  command.push(
    "--extension-command-file",
    commandFile,
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
  );
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stdout).toMatch(
    /^execution=completed grading=completed task=passed\n/m,
  );
  expect(stdout).toContain(
    "domain case=extension-case trial=1 outcome=example.extension.activation status=failed\n",
  );
});
test("CLI selects an advertised extension task policy explicitly", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-policy"),
    ),
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
  expect(
    defined(defined(defined(selected.result.cases[0]).trials[0]).checks[0])
      .status,
  ).toBe("failed");
  const evidence = parseRunEvidence(
    await readFile(defined(selected.result.evidencePath), "utf8"),
  );
  const defaultEvidence = parseRunEvidence(
    await readFile(defined(defaultRun.result.evidencePath), "utf8"),
  );
  expect(evidence.evaluationIdentity.digest).not.toBe(
    defaultEvidence.evaluationIdentity.digest,
  );
  expect(defined(evidence.extension).replacements.taskVerdictPolicy).toBe(
    "example.policy",
  );
  expect(
    defined(defined(evidence.trials[0]).taskVerdictPolicy).recommendation,
  ).toBe("passed");
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
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-replace-regex"),
    ),
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
  expectUnknown(
    defined(defined(selected.result.cases[0]).trials[0]).checks,
  ).toEqual([
    objectContaining({
      id: "example.extension.ready",
      status: "passed",
    }),
  ]);
  const evidence = parseRunEvidence(
    await readFile(defined(selected.result.evidencePath), "utf8"),
  );
  expectUnknown(evidence.graders.replacedDefaults).toEqual(["sevro.regex"]);
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
    JSON.stringify(
      fixtureExtensionCommand(
        extensionSource,
        "lifecycle-instrumentation-supported",
      ),
    ),
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
  const evidence = parseRunEvidence(
    await readFile(defined(enforced.result.evidencePath), "utf8"),
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
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-source-artifact"),
    ),
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
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const [artifact] = defined(evidence.trials[0]).artifactRefs;
  expect(await readFile(new URL(defined(artifact).path), "utf8")).toBe(
    "prepared data\n",
  );
  await writeFile(
    mapFile,
    JSON.stringify({ "input-data": pathToFileURL(commandFile).href }),
  );
  const escaped = await invoke(command);
  expect(escaped.code).toBe(64);
  expect(escaped.result.evidencePath).toBeNull();
  expect(defined(escaped.result.diagnostic).message).toMatch(
    /escapes its declared root/,
  );
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
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
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-repository"),
    ),
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
    "--shell-isolation",
  ]);
  expect(extended.code).toBe(0);
  expectUnknown(
    defined(defined(extended.result.cases[0]).trials[0]).checks.map(
      (check: { id: string }) => check.id,
    ),
  ).toEqual(["ready", "repository-overlay", "example.extension.ready"]);
});
for (const route of ["shell", "native"] as const) {
  // eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
  test(`CLI isolates mapped repository worktrees for ${route} execution`, async () => {
    const installedCodex = availableNativeCodex();
    if (!installedCodex) return;
    const { args, caseFile } = await fixture();
    const projectRoot = join(caseFile, "..");
    const primary = await mkdtemp(join(tmpdir(), "sevro-source-primary-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "sevro-source-cache-"));
    const siblingRoot = await mkdtemp(join(tmpdir(), "sevro-source-peer-"));
    roots.push(primary, sourceRoot, siblingRoot);
    const mapped = join(sourceRoot, "mapped");
    const sibling = join(siblingRoot, "linked");
    await git(primary, "init", "-q");
    await writeFile(join(primary, "README.md"), "repository fixture\n");
    await git(primary, "add", "README.md");
    await git(
      primary,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Create fixture",
    );
    await git(primary, "worktree", "add", "-q", "--detach", mapped);
    await git(primary, "worktree", "add", "-q", "--detach", sibling);
    const definition = fixtureCase();
    definition.fixture = { sourceRef: "fixture-repo" };
    definition.checks.push(
      {
        id: "cloned",
        grader: "sevro.shell",
        configuration: {
          run: "test \"$(cat README.md)\" = 'repository fixture'",
        },
      },
      ...[primary, mapped, sibling].map((root, index) => ({
        id: `source-private-${index}`,
        grader: "sevro.shell",
        configuration: { run: `! cat '${root}/README.md' >/dev/null 2>&1` },
      })),
    );
    const mapFile = join(projectRoot, "source-map.json");
    await writeFile(
      mapFile,
      JSON.stringify({ "fixture-repo": pathToFileURL(mapped).href }),
    );
    let selectedArgs = [
      ...args,
      "--case-source-root",
      sourceRoot,
      "--case-source-map-file",
      mapFile,
      "--shell-isolation",
    ];
    if (route === "native") {
      definition.checks.push({
        id: "meaning",
        grader: "sevro.semantic",
        configuration: { proposition: "The response promises readiness." },
      });
      const authFile = join(projectRoot, "auth.json");
      const binary = join(siblingRoot, "codex-wrapper");
      await writeFile(authFile, "test-only-auth\n", { mode: 0o600 });
      const semantic = JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            checks: [
              { id: "meaning", verdict: "pass", reason: "Ready is stated" },
            ],
          }),
        },
      });
      const advisory = JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            verdict: "pass",
            overallScore: 5,
            dimensions: {
              correctness: 5,
              maintainability: 5,
              testQuality: 5,
              scopeDiscipline: 5,
            },
            strengths: ["Ready"],
            weaknesses: [],
            summary: "Ready.",
          }),
        },
      });
      await writeFile(
        binary,
        `#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-codex\\n'; exit 0; fi
if [ "$1" = sandbox ]; then shift; exec "${installedCodex}" sandbox "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
profile=
for arg in "$@"; do
  case "$arg" in default_permissions=*) profile=$(printf '%s' "$arg" | cut -d= -f2 | tr -d '"');; esac
done
test -n "$profile" || exit 92
"${installedCodex}" sandbox -P "$profile" -C "$PWD" /bin/sh -c 'for source; do if /bin/cat "$source/README.md" >/dev/null 2>&1; then exit 91; fi; done' sevro-source-probe '${primary}' '${mapped}' '${sibling}' || exit 93
printf '%s\\n' '{"type":"thread.started","thread_id":"source-private-cli"}'
message='{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}'
for arg in "$@"; do
  if [ "$arg" = synthetic-judge ]; then message='${semantic}'; fi
  if [ "$arg" = synthetic-reviewer ]; then message='${advisory}'; fi
done
printf '%s\\n' "$message"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
        { mode: 0o700 },
      );
      selectedArgs = selectedArgs.filter(
        (value, index) =>
          value !== "--adapter-module" &&
          selectedArgs[index - 1] !== "--adapter-module",
      );
      selectedArgs.push(
        "--host",
        "codex",
        "--codex-bin",
        binary,
        "--codex-auth-file",
        authFile,
        "--model",
        "synthetic-candidate",
        "--effort",
        "low",
        "--semantic-host",
        "codex",
        "--semantic-model",
        "synthetic-judge",
        "--semantic-effort",
        "low",
        "--advisory-host",
        "codex",
        "--advisory-model",
        "synthetic-reviewer",
        "--advisory-effort",
        "low",
      );
    }
    await writeFile(caseFile, JSON.stringify(definition));
    const run = await invoke(selectedArgs);
    const retained = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    expect(run.code, JSON.stringify(retained.trials[0])).toBe(0);
    expect(run.result.task.verdict).toBe("passed");
    expectUnknown(
      defined(defined(run.result.cases[0]).trials[0]).checks.map(
        (check: { status: string }) => check.status,
      ),
    ).toEqual(definition.checks.map(() => "passed"));
    if (route === "native") {
      const evidence = parseRunEvidence(
        await readFile(defined(run.result.evidencePath), "utf8"),
      );
      expect(defined(evidence.trials[0]).advisoryReview).toMatchObject({
        status: "completed",
        assessment: { verdict: "pass" },
      });
    }
    for (const root of [primary, mapped, sibling]) {
      expect(await readFile(join(root, "README.md"), "utf8")).toBe(
        "repository fixture\n",
      );
    }
  });
}
test("CLI accepts generated Git history from a case or extension", async () => {
  const { args, caseFile } = await fixture();
  const definition = fixtureCase();
  definition.fixture = {
    kind: "generated",
    commits: [
      { message: "chore: initialize", files: { "README.md": "fixture\n" } },
    ],
    files: { "README.md": "staged\n" },
    staged: ["README.md"],
  };
  await writeFile(caseFile, JSON.stringify(definition));
  expect((await invoke(args)).code).toBe(0);
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-generated"),
    ),
  );
  const extensionCommand = args.filter(
    (part, index) =>
      part !== "--case-file" && args[index - 1] !== "--case-file",
  );
  extensionCommand.push(
    "--extension-command-file",
    commandFile,
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
  );
  expect((await invoke(extensionCommand)).code).toBe(0);
  defined(definition.fixture.commits[0]).files = { ".git/config": "escape" };
  await writeFile(caseFile, JSON.stringify(definition));
  const invalid = await invoke(args);
  expect(invalid.code).toBe(64);
  expect(invalid.result.evidencePath).toBeNull();
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

const invalidExternalFlags: {
  name: string;
  extension: boolean;
  flags: string[];
  diagnostic: RegExp;
}[] = [
  {
    name: "unknown flag",
    extension: false,
    flags: ["--unknown-sevro-option"],
    diagnostic: /invalid CLI arguments/,
  },
  {
    name: "missing option value",
    extension: false,
    flags: ["--results-root"],
    diagnostic: /invalid CLI arguments/,
  },
  {
    name: "extra positional command",
    extension: false,
    flags: ["extra-command"],
    diagnostic: /expected the run command/,
  },
  {
    name: "missing extension source closure",
    extension: true,
    flags: [],
    diagnostic: /missing --extension-source-file/,
  },
  {
    name: "relative extension source",
    extension: true,
    flags: ["--extension-source-file", "relative-extension.ts"],
    diagnostic: /--extension-source-file must be absolute/,
  },
  {
    name: "private configuration without redacted file",
    extension: true,
    flags: [
      "--extension-source-file",
      "SOURCE",
      "--extension-configuration-file",
      "CONFIG",
    ],
    diagnostic: /extension configuration requires a redacted file/,
  },
  {
    name: "redacted configuration without private file",
    extension: true,
    flags: [
      "--extension-source-file",
      "SOURCE",
      "--extension-redacted-configuration-file",
      "CONFIG",
    ],
    diagnostic: /extension configuration requires a redacted file/,
  },
];

test.each(invalidExternalFlags.map((entry) => [entry.name, entry] as const))(
  "CLI refuses %s before run admission",
  async (_name, entry) => {
    const { args, caseFile } = await fixture();
    const commandFile = join(dirname(caseFile), "extension-command.json");
    const configuration = join(dirname(caseFile), "configuration.json");
    await writeFile(
      commandFile,
      JSON.stringify(fixtureExtensionCommand(extensionSource, "lifecycle")),
    );
    await writeFile(configuration, "{}");
    const files: Record<string, string> = {
      SOURCE: extensionSource,
      CONFIG: configuration,
    };
    const base = entry.extension
      ? args.filter((arg) => arg !== "--case-file" && arg !== caseFile)
      : args;
    const declaration = entry.extension
      ? ["--extension-command-file", commandFile, "--case-id", "extension-case"]
      : [];
    const invalid = await invoke([
      ...base,
      ...declaration,
      ...entry.flags.map((arg) => files[arg] ?? arg),
    ]);
    expect(invalid.code).toBe(64);
    expect(defined(invalid.result.diagnostic).message).toMatch(
      entry.diagnostic,
    );
    expect(invalid.result).toMatchObject({
      execution: { status: "not_run" },
      grading: { status: "not_requested" },
      task: { verdict: "not_assessed" },
      exitCode: 64,
      evidencePath: null,
      cases: [],
    });
  },
);
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
  expect(defined(missingIsolation.result.diagnostic).message).toMatch(
    /protected source roots/,
  );
  const isolated = await invoke([
    ...args,
    "--shell-isolation",
    "--protected-root",
    join(caseFile, ".."),
  ]);
  expect(isolated.code).toBe(0);
  expect(
    defined(defined(defined(isolated.result.cases[0]).trials[0]).checks[0]),
  ).toMatchObject({
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
  const active = parseCheckpoint(
    await readFile(
      join(runStateRoot, "active", `${run.result.runId}.json`),
      "utf8",
    ),
  );
  expect(active.status).toBe("complete");
  expect(active.artifactPath).toBe(defined(run.result.evidencePath));
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
    const cancelled = new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error("cancelled"));
      else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    cancelled.catch(() => {});
    await writeFile(${JSON.stringify(ready)}, "ready");
    return cancelled;
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
      const result = parseCliResult(stdout);
      expect(result.execution.status).toBe("cancelled");
      expect(result.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
      const active = parseCheckpoint(
        await readFile(
          join(projectRoot, "results", "active", `${result.runId}.json`),
          "utf8",
        ),
      );
      expect(active.status).toBe("interrupted");
      expect(await Bun.file(defined(result.evidencePath)).exists()).toBeTrue();
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });
}
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("CLI imports only the Codex limit from its separate configuration root", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const configRoot = await mkdtemp(join(tmpdir(), "sevro-config-root-"));
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-config-bin-"));
  roots.push(configRoot, binRoot);
  const binary = join(binRoot, "codex-wrapper");
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
  expect(run.code, JSON.stringify(run.result.diagnostic)).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expectUnknown(evidence.configuration.redacted.hostConfiguration).toEqual({
    candidate: { "sevro.codex.agent-concurrency-limit": 7 },
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
    candidate: { "sevro.codex.agent-concurrency-limit": 9 },
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
  if (process.platform !== "darwin" || !Bun.which("codex")) return;
  const { args, caseFile } = await fixture();
  const configRoot = await mkdtemp(join(tmpdir(), "sevro-config-repo-"));
  const worktreeParent = await mkdtemp(
    join(tmpdir(), "sevro-config-worktree-"),
  );
  roots.push(configRoot, worktreeParent);
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
    ).toEqual({ "sevro.codex.agent-concurrency-limit": null });
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
      candidate: { "sevro.codex.agent-concurrency-limit": limit },
      semantic: { "sevro.codex.agent-concurrency-limit": limit },
      advisory: { "sevro.codex.agent-concurrency-limit": limit },
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
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
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
  const advisoryEvent = JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        verdict: "fail",
        overallScore: 2,
        dimensions: {
          correctness: 2,
          maintainability: 3,
          testQuality: 2,
          scopeDiscipline: 4,
        },
        strengths: ["Small change"],
        weaknesses: ["Missing validation"],
        summary: "A correctness gap remains.",
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
  if [ "$arg" = synthetic-reviewer ]; then
    printf '%s\\n' '${advisoryEvent}'
    printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":2}}'
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
  const trial = parseTrial(
    await readFile(
      defined(defined(defined(run.result.cases[0]).trials[0]).artifactPath),
      "utf8",
    ),
  );
  expect(defined(trial.evidence.routes[0])).toMatchObject({
    host: "sevro.host.codex",
    model: "synthetic-codex",
  });
  const invalid = await invoke([...args, ...codexArgs.slice(-10)]);
  expect(invalid.code).toBe(64);
  const definition = fixtureCase();
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
  const semanticEvidence = parseRunEvidence(
    await readFile(defined(semanticRun.result.evidencePath), "utf8"),
  );
  expect(defined(semanticEvidence.routes[1])).toMatchObject({
    role: "semantic",
    host: "sevro.host.codex",
    model: "synthetic-judge",
  });
  expectUnknown(defined(semanticEvidence.trials[0]).artifactRefs).toEqual(
    arrayContaining([
      objectContaining({ id: "sevro.semantic.sevro.codex.events" }),
    ]),
  );
  definition.checks.pop();
  definition.fixture = {
    kind: "generated",
    commits: [
      {
        message: "Add baseline",
        files: {
          "README.md": "fixture\n",
          "app.ts": "export const value = 1;\n",
        },
      },
    ],
    files: { "app.ts": "export const value = 2;\n" },
  };
  await writeFile(caseFile, JSON.stringify(definition));
  const advisoryRun = await invoke([
    ...args,
    "--advisory-host",
    "codex",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    authFile,
    "--advisory-model",
    "synthetic-reviewer",
    "--advisory-effort",
    "low",
  ]);
  expect(advisoryRun.code).toBe(0);
  const advisoryEvidence = parseRunEvidence(
    await readFile(defined(advisoryRun.result.evidencePath), "utf8"),
  );
  expect(defined(advisoryEvidence.routes[1])).toMatchObject({
    role: "advisory",
    host: "sevro.host.codex",
    model: "synthetic-reviewer",
  });
  expect(defined(advisoryEvidence.trials[0]).advisoryReview).toMatchObject({
    status: "completed",
    assessment: { verdict: "fail" },
  });
  const conflicting = await invoke([
    ...semanticArgs,
    "--semantic-adapter-module",
    semanticAdapter,
  ]);
  expect(conflicting.code).toBe(64);
});
async function claudeContinuationFixture(scenario = "pass") {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const credentialFile = join(projectRoot, "claude-credentials.json");
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-claude-resume-bin-"));
  roots.push(binRoot);
  const binary = join(binRoot, "claude-wrapper");
  const launches = join(binRoot, "launches.txt");
  const definition = fixtureCase();
  definition.fixture = {
    kind: "generated",
    commits: [
      { message: "chore: initial", files: { "README.md": "fixture\n" } },
    ],
  };
  definition.followUpPrompt = "Resume the same task and return ready.";
  await writeFile(caseFile, JSON.stringify(definition));
  await writeFile(credentialFile, '{"test":"synthetic-login"}', {
    mode: 0o600,
  });
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFile, readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};
const option = (name) => args[args.indexOf(name) + 1];
const resumed = args.includes("--resume");
const session = option(resumed ? "--resume" : "--session-id");
if (!/^[0-9a-f-]{36}$/.test(session)) process.exit(9);
await appendFile(${JSON.stringify(launches)}, resumed ? "resume\\n" : "initial\\n");
const state = JSON.stringify({ session, config: process.env.CLAUDE_CONFIG_DIR, settings: option("--settings"), model: option("--model"), effort: option("--effort") });
if (resumed) {
  if (await readFile(".git/session-proof", "utf8") !== state || option("-p") !== ${JSON.stringify(definition.followUpPrompt)}) process.exit(10);
} else await writeFile(".git/session-proof", state);
if (!resumed && scenario === "changed-worktree") await writeFile("README.md", "changed before feedback\\n");
if (!resumed && scenario === "unmeasured-worktree") Bun.spawnSync(["mkfifo", "unmeasured-pipe"]);
const affected = (scenario.endsWith("initial") && !resumed) || (scenario.endsWith("follow-up") && resumed);
const failed = affected && scenario.startsWith("failed-");
const event = { type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed,
  session_id: affected && scenario.startsWith("missing-") ? undefined : affected && scenario.startsWith("foreign-") ? "00000000-0000-0000-0000-000000000000" : session,
  result: resumed || failed ? "ready" : "waiting",
  usage: resumed && scenario === "incomplete-usage" ? undefined : { input_tokens: resumed ? 3 : 1, output_tokens: resumed ? 4 : 2 }, total_cost_usd: resumed ? 0.02 : 0.01 };
process.stdout.write(JSON.stringify(event) + "\\n");
if (affected && scenario.startsWith("duplicate-")) process.stdout.write(JSON.stringify(event) + "\\n");
`,
    { mode: 0o700 },
  );
  const command = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  return {
    command: [
      ...command,
      "--host",
      "claude",
      "--claude-bin",
      binary,
      "--claude-credential-file",
      credentialFile,
      "--model",
      "sonnet",
      "--effort",
      "low",
    ],
    launches,
  };
}
async function claudeCacheFixture() {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const binaryRoot = await mkdtemp(join(tmpdir(), "sevro-cache-bin-"));
  roots.push(binaryRoot);
  const binary = join(binaryRoot, "claude");
  const credentialFile = join(projectRoot, "credential.json");
  const uvCacheDir = join(binaryRoot, "uv-cache");
  await mkdir(uvCacheDir);
  await writeFile(join(uvCacheDir, "sentinel"), "curated");
  await writeFile(credentialFile, '{"test":"synthetic-login"}', {
    mode: 0o600,
  });
  const definition = fixtureCase();
  definition.fixture = {
    kind: "generated",
    commits: [
      { message: "chore: initial", files: { "README.md": "fixture\n" } },
    ],
  };
  await writeFile(caseFile, JSON.stringify(definition));
  await writeFile(
    binary,
    `#!${process.execPath}
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, join } from "node:path";
if (Object.hasOwn(process.env, "DARROW_CACHE_DIR")) process.exit(8);
const home = await realpath(process.env.HOME);
const path = relative(join(process.cwd(), ".git"), home);
if (!isAbsolute(home) || path === ".." || path.startsWith("../") || isAbsolute(path)) process.exit(9);
if (await readFile(join(process.env.UV_CACHE_DIR, "sentinel"), "utf8") !== "curated" ||
    process.env.UV_OFFLINE !== "1" || process.env.PYTHONDONTWRITEBYTECODE !== "1") process.exit(10);
await mkdir(join(home, ".tool-cache"), { recursive: true });
await writeFile(join(home, ".tool-cache", "probe"), "isolated");
await writeFile(".git/candidate-home", home);
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ready" }) + "\\n");
`,
    { mode: 0o700 },
  );
  const command = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  return {
    caseFile,
    command: [
      ...command,
      "--host",
      "claude",
      "--claude-bin",
      binary,
      "--claude-credential-file",
      credentialFile,
      "--claude-uv-cache-dir",
      uvCacheDir,
      "--model",
      "synthetic",
      "--effort",
      "low",
    ],
  };
}
test("CLI curated Claude runtime leaves repository caches to tools", async () => {
  if (process.platform !== "darwin") return;
  const { command } = await claudeCacheFixture();
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DARROW_CACHE_DIR: "/unavailable-caller-cache" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const result = parseCliResult(stdout);
  expect(code, stderr + stdout).toBe(0);
  expect(result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "passed" },
  });
});
test("CLI curated shell grading leaves repository caches to tools", async () => {
  if (process.platform !== "darwin") return;
  const { command, caseFile } = await claudeCacheFixture();
  const definition = fixtureCase();
  definition.checks.push({
    id: "isolated-cache",
    grader: "sevro.shell",
    configuration: {
      run: 'test -z "${DARROW_CACHE_DIR+x}" && test "$(cat "$UV_CACHE_DIR/sentinel")" = curated && test "$UV_OFFLINE" = 1 && test "$HOME" != "$(cat .git/candidate-home)" && mkdir -p "$HOME/.tool-cache" && printf isolated > "$HOME/.tool-cache/probe" && test "$(git status --porcelain)" = ""',
    },
  });
  await writeFile(caseFile, JSON.stringify(definition));
  const run = await invoke([...command, "--shell-isolation"], "pass", {
    DARROW_CACHE_DIR: "/unavailable-caller-cache",
  });
  expect(run.code, run.stderr + JSON.stringify(run.result)).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  expectUnknown(
    defined(defined(run.result.cases[0]).trials[0]).checks,
  ).toContainEqual(
    objectContaining({ id: "isolated-cache", status: "passed" }),
  );
});
test("CLI resumes Claude in the same isolated session and grades its final turn", async () => {
  if (process.platform !== "darwin") return;
  const { command, launches } = await claudeContinuationFixture();
  const run = await invoke(command);
  expect(run.code, run.stderr + JSON.stringify(run.result)).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  const continuation = trial.observations.find(
    (item: { id: string }) => item.id === "sevro.claude.continuation",
  );
  expect(continuation).toMatchObject({
    source: "sevro.host.claude",
    completeness: "complete",
    data: { method: "same_session_resume", preFollowUpWorktreeUnchanged: true },
  });
  const initial = trial.artifactRefs.find(
    (item: { id: string }) => item.id === "sevro.claude.initial-events",
  );
  const followUp = trial.artifactRefs.find(
    (item: { id: string }) => item.id === "sevro.claude.follow-up-events",
  );
  const first = parseRecord(
    (await readFile(new URL(defined(initial).path), "utf8")).trim(),
  );
  const last = parseRecord(
    (await readFile(new URL(defined(followUp).path), "utf8")).trim(),
  );
  expect(first.result).toBe("waiting");
  expect(last.result).toBe("ready");
  expect(first.session_id).toBe(defined(continuation).data.sessionId);
  expect(last.session_id).toBe(first.session_id);
  expect(trial.usage).toMatchObject({
    inputTokens: 4,
    outputTokens: 6,
    costUsd: 0.03,
    complete: true,
  });
  expect(await readFile(launches, "utf8")).toBe("initial\nresume\n");
});
test.each([
  "failed-initial",
  "missing-initial",
  "foreign-initial",
  "duplicate-initial",
  "failed-follow-up",
  "missing-follow-up",
  "foreign-follow-up",
  "duplicate-follow-up",
])(
  "Claude continuation never grades failed or unbound native results: %s",
  async (scenario) => {
    if (process.platform !== "darwin") return;
    const { command, launches } = await claudeContinuationFixture(scenario);
    const run = await invoke(command);
    expect(run.code, scenario + JSON.stringify(run.result)).toBe(2);
    expect(run.result).toMatchObject({
      execution: { status: "failed" },
      grading: { status: "not_requested" },
      task: { verdict: "not_assessed" },
    });
    expect(await readFile(launches, "utf8")).toBe(
      scenario.endsWith("initial") ? "initial\n" : "initial\nresume\n",
    );
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    expectUnknown(
      defined(defined(run.result.cases[0]).trials[0]).checks,
    ).toEqual([]);
    const artifact = defined(evidence.trials[0]).artifactRefs.find(
      (item: { id: string }) => item.id === "sevro.claude.events",
    );
    expect(artifact).toBeDefined();
    expect(await readFile(new URL(defined(artifact).path), "utf8")).toContain(
      '"type":"result"',
    );
    if (scenario.endsWith("follow-up")) {
      expect(
        defined(evidence.trials[0]).observations.find(
          (item: { id: string }) => item.id === "sevro.claude.continuation",
        ),
      ).toMatchObject({ completeness: "partial" });
    }
  },
  10000,
);
test("CLI leaves Claude usage unmeasured when a resumed result belongs to another session", async () => {
  if (process.platform !== "darwin") return;
  const { command } = await claudeContinuationFixture("foreign-follow-up");
  const run = await invoke(command);
  expect(run.code).toBe(2);
  expect(run.result.task.verdict).toBe("not_assessed");
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(defined(evidence.trials[0]).usage).toMatchObject({
    complete: false,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
});
test("Claude continuation keeps workspace and usage uncertainty explicit", async () => {
  if (process.platform !== "darwin") return;
  for (const scenario of [
    "changed-worktree",
    "unmeasured-worktree",
    "incomplete-usage",
  ]) {
    const { command } = await claudeContinuationFixture(scenario);
    const run = await invoke(command);
    expect(run.code, JSON.stringify(run.result)).toBe(0);
    expect(run.result.task.verdict).toBe("passed");
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    const trial = defined(evidence.trials[0]);
    expect(
      trial.observations.find(
        (item: { id: string }) => item.id === "sevro.claude.continuation",
      ),
    ).toMatchObject(expectedContinuationState(scenario));
    if (scenario === "incomplete-usage")
      expect(trial.usage).toMatchObject({
        complete: false,
        inputTokens: null,
        outputTokens: null,
        costUsd: 0.03,
      });
  }
});
test("CLI runs its bundled Claude route with isolated credentials", async () => {
  if (process.platform !== "darwin") return;
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const credentialFile = join(projectRoot, "claude-credentials.json");
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-claude-bin-"));
  roots.push(binRoot);
  const binary = join(binRoot, "claude-wrapper");
  await writeFile(credentialFile, '{"test":"private-login"}', {
    mode: 0o600,
  });
  await writeFile(
    binary,
    [
      "#!/bin/sh",
      'test -r "$CLAUDE_CONFIG_DIR/.credentials.json" || exit 3',
      'printf \'%s\\n\' \'{"type":"result","subtype":"success","is_error":false,"result":"ready","usage":{"input_tokens":1,"output_tokens":2},"total_cost_usd":0.01}\'',
    ].join("\n") + "\n",
    { mode: 0o700 },
  );
  const withoutAdapter = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  const claudeArgs = [
    ...withoutAdapter,
    "--host",
    "claude",
    "--claude-bin",
    binary,
    "--claude-credential-file",
    credentialFile,
    "--model",
    "sonnet",
    "--effort",
    "low",
  ];
  const run = await invoke(claudeArgs);
  expect(run.code).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const trial = parseTrial(
    await readFile(
      defined(defined(defined(run.result.cases[0]).trials[0]).artifactPath),
      "utf8",
    ),
  );
  expect(defined(trial.evidence.routes[0])).toMatchObject({
    host: "sevro.host.claude",
    model: "sonnet",
  });
  const invalid = await invoke([...args, ...claudeArgs.slice(-10)]);
  expect(invalid.code).toBe(64);
});
