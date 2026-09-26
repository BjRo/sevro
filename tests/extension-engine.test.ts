import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runEvaluation, type HostAdapter } from "../src/engine";
import { openExtensionSession } from "../src/extension-session";
import instrumentedHost from "./fixtures/instrumented-adapter";

const roots: string[] = [];
const source = join(import.meta.dir, "fixtures", "extension.ts");
const digest = "a".repeat(64);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function runWithExtension(
  scenario: string,
  hostAction?: (workspace: string, resultsRoot: string) => Promise<void>,
  replaceBuiltinGraders: string[] = [],
  hostOverride?: HostAdapter,
  condition: "passive" | "enforced" = "passive",
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-extension-engine-"));
  roots.push(projectRoot);
  const sourcePath = join(projectRoot, "case-sources", "data.txt");
  if (scenario === "lifecycle-source-artifact")
    await Bun.write(sourcePath, "prepared data\n");
  const session = await openExtensionSession({
    command: [process.execPath, source, scenario],
    sourceFiles: [source],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: (hostOverride?.instrumentation ?? []).map(
      (item) => item.id,
    ),
    replaceBuiltinGraders,
    ...(scenario.startsWith("lifecycle-policy")
      ? { taskVerdictPolicy: "example.policy" }
      : {}),
  });
  const [resolvedCase] = await session.resolve(
    new URL(`file://${projectRoot}/`).href,
    {},
  );
  if (!resolvedCase || resolvedCase.fixture.kind !== "inline")
    throw new Error("fixture mismatch");
  const syntheticHost: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run({ workspace }) {
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
        "fixture\n",
      );
      if (
        scenario === "lifecycle-artifact" ||
        scenario === "lifecycle-source-artifact"
      )
        expect(
          await readFile(join(workspace, "generated/data.txt"), "utf8"),
        ).toBe("prepared data\n");
      await hostAction?.(workspace, join(projectRoot, "results"));
      return {
        finalMessage: "ready",
        complete: true,
        actualCondition: "passive",
        ...(scenario === "lifecycle-host-observation"
          ? {
              observations: [
                {
                  id: "darrow.activation",
                  completeness: "complete" as const,
                  data: { selected: "darrow.tdd" },
                },
              ],
            }
          : {}),
        ...(scenario === "lifecycle-host-artifact"
          ? {
              artifacts: [
                {
                  id: "example.host.trace",
                  bytes: Buffer.from("host trace\n"),
                },
              ],
            }
          : {}),
      };
    },
  };
  const host = hostOverride ?? syntheticHost;
  const outcome = await runEvaluation({
    projectRoot,
    resultsRoot: join(projectRoot, "results"),
    case: {
      id: resolvedCase.id,
      prompt: resolvedCase.prompt,
      fixture: { files: resolvedCase.fixture.files },
      checks: resolvedCase.checks,
      requiredEvidence: resolvedCase.requiredEvidence,
    },
    extension: { session, resolvedCase },
    ...(scenario === "lifecycle-source-artifact"
      ? {
          preparationSources: {
            root: join(projectRoot, "case-sources"),
            refs: { "input-data": pathToFileURL(sourcePath).href },
          },
        }
      : {}),
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition,
    trialCount: 1,
    passThreshold: 1,
  });
  const evidence = JSON.parse(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  return { outcome, evidence, session };
}

test("extension checks add to built-ins and retain negotiated provenance", async () => {
  const { outcome, evidence, session } = await runWithExtension("lifecycle");
  expect(outcome.result.exitCode).toBe(0);
  expect(
    outcome.result.cases[0]?.trials[0]?.checks.map((check) => check.id),
  ).toEqual(["ready", "example.extension.ready"]);
  expect(outcome.result.cases[0]?.trials[0]?.checks[1]?.evidenceRefs).toEqual([
    "sevro.observation.final-message",
  ]);
  expect(evidence.extension).toMatchObject({
    id: "example.extension",
    protocol: "sevro.extension.v1",
    sourceDigest: session.identity.sourceDigest,
  });
  expect(evidence.evaluationIdentity.dimensions.extensionDigest).toBe(
    session.identity.sourceDigest,
  );
  expect(evidence.trials[0].metrics).toEqual([
    { id: "example.extension.score", value: 1, unit: "ratio" },
  ]);
  expect(
    evidence.graders.active.map((grader: { id: string }) => grader.id),
  ).toEqual(["sevro.regex", "example.extension"]);
});

test("explicit grader replacement removes only the selected built-in checks", async () => {
  const defaultRun = await runWithExtension("lifecycle-replace-regex");
  expect(defaultRun.outcome.result.task.verdict).toBe("failed");
  expect(
    defaultRun.outcome.result.cases[0]?.trials[0]?.checks.map(
      (check) => check.id,
    ),
  ).toEqual(["ready", "example.extension.ready"]);

  const selected = await runWithExtension(
    "lifecycle-replace-regex",
    undefined,
    ["sevro.regex"],
  );
  expect(selected.outcome.result.task.verdict).toBe("passed");
  expect(
    selected.outcome.result.cases[0]?.trials[0]?.checks.map(
      (check) => check.id,
    ),
  ).toEqual(["example.extension.ready"]);
  expect(selected.evidence.graders).toMatchObject({
    active: [{ id: "example.extension", source: "extension" }],
    replacedDefaults: ["sevro.regex"],
  });
  expect(selected.evidence.extension.replacements.graders).toEqual([
    "sevro.regex",
  ]);
  expect(selected.evidence.evaluationIdentity.digest).not.toBe(
    defaultRun.evidence.evaluationIdentity.digest,
  );
  await expect(
    runWithExtension("lifecycle-replace-regex", undefined, ["sevro.json"]),
  ).rejects.toThrow(/unknown or duplicate built-in grader replacement/);
  await expect(
    runWithExtension("lifecycle-replace-no-extension", undefined, [
      "sevro.regex",
    ]),
  ).rejects.toThrow(/requires an extension check/);
  const shell = await runWithExtension("lifecycle-replace-shell", undefined, [
    "sevro.shell",
  ]);
  expect(shell.outcome.result.task.verdict).toBe("passed");
  expect(shell.evidence.trials[0].observations).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "sevro.shell" }),
    ]),
  );
  const semantic = await runWithExtension(
    "lifecycle-replace-semantic",
    undefined,
    ["sevro.semantic"],
  );
  expect(semantic.outcome.result.task.verdict).toBe("passed");
  expect(
    semantic.evidence.routes.map((route: { role: string }) => route.role),
  ).toEqual(["candidate"]);
});

test("selected task policy may replace a failed check verdict and retains its decision", async () => {
  const { outcome, evidence } = await runWithExtension("lifecycle-policy");
  expect(outcome.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "passed" },
    exitCode: 0,
  });
  expect(outcome.result.cases[0]?.trials[0]?.checks[0]?.status).toBe("failed");
  expect(evidence.extension.replacements.taskVerdictPolicy).toBe(
    "example.policy",
  );
  expect(evidence.trials[0].taskVerdictPolicy).toEqual({
    id: "example.policy",
    recommendation: "passed",
  });
  const missing = await runWithExtension("lifecycle-policy-missing");
  expect(missing.outcome.result).toMatchObject({
    grading: { status: "error" },
    task: { verdict: "not_assessed" },
    exitCode: 3,
  });
  const unavailable = await runWithExtension("lifecycle-policy-unavailable");
  expect(unavailable.outcome.result).toMatchObject({
    grading: { status: "unavailable" },
    task: { verdict: "not_assessed" },
    exitCode: 4,
  });
  const failedHost = await runWithExtension("lifecycle-policy", async () => {
    throw new Error("host failed");
  });
  expect(failedHost.outcome.result).toMatchObject({
    execution: { status: "failed" },
    task: { verdict: "not_assessed" },
    exitCode: 2,
  });
});

test("extension grading receives complete host observations", async () => {
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-host-observation",
  );
  expect(outcome.result.task.verdict).toBe("passed");
  expect(outcome.result.cases[0]?.trials[0]?.checks[1]?.evidenceRefs).toEqual([
    "darrow.activation",
  ]);
  expect(evidence.trials[0].observations[1]).toMatchObject({
    id: "darrow.activation",
    completeness: "complete",
    data: { selected: "darrow.tdd" },
  });
});

test("extension grading receives retained host artifacts", async () => {
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-host-artifact",
  );
  expect(outcome.result.task.verdict).toBe("passed");
  expect(outcome.result.cases[0]?.trials[0]?.checks[1]?.evidenceRefs).toEqual([
    "example.host.trace",
  ]);
  const artifact = evidence.trials[0].artifactRefs.find(
    (item: { id: string }) => item.id === "example.host.trace",
  );
  expect(artifact).toBeDefined();
  expect(await readFile(new URL(artifact.path), "utf8")).toBe("host trace\n");
});

test("extension grading error cannot become a passing task", async () => {
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-empty-evidence",
  );
  expect(outcome.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "error" },
    task: { verdict: "not_assessed" },
    exitCode: 3,
  });
  expect(evidence.diagnostic.code).toBe("sevro.grader.error");
  expect(outcome.result.cases[0]?.trials[0]?.checks[0]?.status).toBe("passed");
});

test("an omitted declared extension check leaves grading unavailable", async () => {
  const { outcome } = await runWithExtension("lifecycle-missing-check");
  expect(outcome.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "unavailable" },
    task: { verdict: "not_assessed" },
    exitCode: 4,
  });
});

test("unsupported instrumentation stops before host execution", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-extension-prepare-"));
  roots.push(projectRoot);
  const session = await openExtensionSession({
    command: [process.execPath, source, "lifecycle-instrumentation"],
    sourceFiles: [source],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
  });
  const [resolvedCase] = await session.resolve(
    new URL(`file://${projectRoot}/`).href,
    {},
  );
  if (!resolvedCase || resolvedCase.fixture.kind !== "inline")
    throw new Error("fixture mismatch");
  let called = false;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run() {
      called = true;
      return { finalMessage: "ready", complete: true };
    },
  };
  await expect(
    runEvaluation({
      projectRoot,
      resultsRoot: join(projectRoot, "results"),
      case: {
        id: resolvedCase.id,
        prompt: resolvedCase.prompt,
        fixture: { files: resolvedCase.fixture.files },
        checks: resolvedCase.checks,
        requiredEvidence: resolvedCase.requiredEvidence,
      },
      extension: { session, resolvedCase },
      host,
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    }),
  ).rejects.toThrow(/unsupported instrumentation/);
  expect(called).toBe(false);
});

test("negotiated instrumentation records host application and rejects condition drift", async () => {
  const supported = await runWithExtension(
    "lifecycle-instrumentation-supported",
    undefined,
    [],
    instrumentedHost,
    "enforced",
  );
  expect(supported.outcome.result.task.verdict).toBe("passed");
  expect(supported.evidence.condition).toMatchObject({
    requested: "enforced",
    actual: "enforced",
    requestedInstrumentation: [
      { id: "example.extension.guard", configuration: {} },
    ],
    appliedInstrumentation: [
      { id: "example.extension.guard", configuration: {} },
    ],
  });
  expect(supported.evidence.trials[0].condition.appliedInstrumentation).toEqual(
    supported.evidence.condition.requestedInstrumentation,
  );
  expect(supported.evidence.extension.capabilities).toContain(
    "example.extension.guard",
  );
  await expect(
    runWithExtension(
      "lifecycle-instrumentation",
      undefined,
      [],
      instrumentedHost,
      "enforced",
    ),
  ).rejects.toThrow(/unsupported instrumentation/);
  const observational = await runWithExtension(
    "lifecycle-instrumentation-observational",
    undefined,
    [],
    instrumentedHost,
    "passive",
  );
  expect(observational.outcome.result.task.verdict).toBe("passed");
  expect(observational.evidence.condition).toMatchObject({
    requested: "passive",
    actual: "passive",
    appliedInstrumentation: [
      { id: "example.extension.trace", configuration: {} },
    ],
  });
  await expect(
    runWithExtension(
      "lifecycle-instrumentation-supported",
      undefined,
      [],
      instrumentedHost,
      "passive",
    ),
  ).rejects.toThrow(/passive condition cannot apply/);
  const mismatch = await runWithExtension(
    "lifecycle-instrumentation-supported",
    undefined,
    [],
    {
      ...instrumentedHost,
      async run(request) {
        return {
          ...(await instrumentedHost.run(request)),
          appliedInstrumentation: [],
        };
      },
    },
    "enforced",
  );
  expect(mismatch.outcome.result).toMatchObject({
    execution: { status: "failed" },
    task: { verdict: "not_assessed" },
    exitCode: 2,
  });
  expect(mismatch.evidence.diagnostic.code).toBe(
    "sevro.instrumentation.mismatch",
  );
  expect(mismatch.evidence.condition.appliedInstrumentation).toEqual([]);
  const conditionDrift = await runWithExtension(
    "lifecycle-instrumentation-supported",
    undefined,
    [],
    {
      ...instrumentedHost,
      async run(request) {
        return {
          ...(await instrumentedHost.run(request)),
          actualCondition: "passive",
        };
      },
    },
    "enforced",
  );
  expect(conditionDrift.outcome.result.exitCode).toBe(2);
  expect(conditionDrift.evidence.diagnostic.code).toBe(
    "sevro.instrumentation.mismatch",
  );
});

test("prepared inline artifacts survive fixture cleanup with their digest", async () => {
  const { outcome, evidence } = await runWithExtension("lifecycle-artifact");
  expect(outcome.result.exitCode).toBe(0);
  const [artifact] = evidence.trials[0].artifactRefs;
  expect(artifact.id).toBe("generated-file");
  expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await readFile(new URL(artifact.path), "utf8")).toBe(
    "prepared data\n",
  );
});

test("declared source artifacts are retained and mounted with verified bytes", async () => {
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-source-artifact",
  );
  expect(outcome.result.exitCode).toBe(0);
  const [artifact] = evidence.trials[0].artifactRefs;
  expect(await readFile(new URL(artifact.path), "utf8")).toBe(
    "prepared data\n",
  );
});

test("a wrong preparation digest fails before host execution", async () => {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "sevro-extension-bad-artifact-"),
  );
  roots.push(projectRoot);
  const session = await openExtensionSession({
    command: [process.execPath, source, "lifecycle-bad-artifact"],
    sourceFiles: [source],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
  });
  const [resolvedCase] = await session.resolve(
    new URL(`file://${projectRoot}/`).href,
    {},
  );
  if (!resolvedCase || resolvedCase.fixture.kind !== "inline")
    throw new Error("fixture mismatch");
  let called = false;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run() {
      called = true;
      return { finalMessage: "ready", complete: true };
    },
  };
  await expect(
    runEvaluation({
      projectRoot,
      resultsRoot: join(projectRoot, "results"),
      case: {
        id: resolvedCase.id,
        prompt: resolvedCase.prompt,
        fixture: { files: resolvedCase.fixture.files },
        checks: resolvedCase.checks,
        requiredEvidence: resolvedCase.requiredEvidence,
      },
      extension: { session, resolvedCase },
      host,
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    }),
  ).rejects.toThrow(/preparation artifact digest/);
  expect(called).toBe(false);
});

test("a changed retained artifact cannot support a successful result", async () => {
  let workspace = "";
  try {
    await expect(
      runWithExtension("lifecycle-artifact", async (fixture, resultsRoot) => {
        workspace = fixture;
        const runId = (await readdir(resultsRoot)).find((name) =>
          /^[a-f0-9]{8}-/.test(name),
        );
        await writeFile(
          join(resultsRoot, runId!, "prepared/generated/data.txt"),
          "tampered\n",
        );
      }),
    ).rejects.toThrow(/retained preparation artifact changed/);
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
});
