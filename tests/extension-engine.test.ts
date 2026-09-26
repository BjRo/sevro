import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluation, type HostAdapter } from "../src/engine";
import { openExtensionSession } from "../src/extension-session";

const roots: string[] = [];
const source = join(import.meta.dir, "fixtures", "extension.ts");
const digest = "a".repeat(64);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function runWithExtension(scenario: string) {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-extension-engine-"));
  roots.push(projectRoot);
  const session = await openExtensionSession({
    command: [process.execPath, source, scenario],
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
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run({ workspace }) {
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
        "fixture\n",
      );
      return {
        finalMessage: "ready",
        complete: true,
        actualCondition: "passive",
      };
    },
  };
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
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
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
  ).rejects.toThrow(/unsupported artifacts or instrumentation/);
  expect(called).toBe(false);
});
