import { expectUnknown } from "../fixtures/assertions";
import {
  defined,
  objectContaining,
  parseJson,
  parseRunEvidence,
} from "../fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extensionSource, invoke } from "../fixtures/cli-fixtures";
import { createFixture } from "../fixtures/cli-fixtures";
import { extensionFixtureCommand } from "../fixtures/extension-command";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = createFixture(roots);
const fixtureExtensionCommand = extensionFixtureCommand();

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

test("CLI reports when declared extension source changes during candidate execution", async () => {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const commandFile = join(projectRoot, "extension-command.json");
  const sourceFile = join(projectRoot, "declared-input.ts");
  const initialSource = "export const evaluatorInput = 'stable';\n";
  await writeFile(sourceFile, initialSource);
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
    "--extension-source-file",
    sourceFile,
    "--case-id",
    "extension-case",
  );
  const environment = {
    SEVRO_TEST_MUTATE_EXTENSION_SOURCE: sourceFile,
  };
  const jsonRun = await invoke(command, "pass", environment);
  expect(jsonRun.code).toBe(3);
  expect(jsonRun.result.execution.status).toBe("completed");
  expect(jsonRun.result.grading.status).toBe("error");
  expect(jsonRun.result.task.verdict).toBe("not_assessed");
  const diagnosticMessage =
    "extension source inputs changed during evaluation; assessment was refused. Finish changing evaluator inputs, then start a fresh evaluation with inputs held stable.";
  const cliDiagnostic = defined(jsonRun.result.diagnostic);
  expect(cliDiagnostic.message).toBe(diagnosticMessage);
  expect(cliDiagnostic.message).not.toContain(sourceFile);
  expect(cliDiagnostic.message).not.toContain("changed during run");
  expect(defined(defined(jsonRun.result.cases[0]).trials[0])).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "error" },
    task: { verdict: "not_assessed" },
    checks: [{ id: "ready", status: "passed" }],
  });
  const jsonEvidence = parseRunEvidence(
    await readFile(defined(jsonRun.result.evidencePath), "utf8"),
  );
  expect(jsonEvidence.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "error" },
    task: { verdict: "not_assessed" },
  });
  const evidenceDiagnostic = defined(jsonEvidence.diagnostic);
  expect(evidenceDiagnostic.message).toBe(diagnosticMessage);
  expect(evidenceDiagnostic.message).not.toContain(sourceFile);
  expect(evidenceDiagnostic.message).not.toContain("changed during run");

  await writeFile(sourceFile, initialSource);
  const humanCommand = command.filter((part) => part !== "--json");
  const proc = Bun.spawn(humanCommand, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment, SEVRO_TEST_SCENARIO: "pass" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, stdout + stderr).toBe(3);
  expect(stdout).toContain(diagnosticMessage);
  expect(stdout).not.toContain(sourceFile);
});

test("CLI sanitizes unknown extension grading failures", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-private-error"),
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
  const run = await invoke(command);
  expect(run.code).toBe(3);
  expect(run.result.execution.status).toBe("completed");
  expect(run.result.grading.status).toBe("error");
  expect(run.result.task.verdict).toBe("not_assessed");
  expect(run.result.diagnostic).toEqual({
    code: "sevro.grader.error",
    message: "extension grading did not complete",
  });
  const evidenceText = await readFile(defined(run.result.evidencePath), "utf8");
  expect(evidenceText).not.toContain("private-evaluator-sentinel");
  expect(evidenceText).not.toContain("/sensitive/evaluator/source.ts");
  expect(run.stdout).not.toContain("private-evaluator-sentinel");
  expect(run.stdout).not.toContain("/sensitive/evaluator/source.ts");
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
