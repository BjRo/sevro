import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import cliSchema from "../schemas/cli-result-v1.schema.json";
import extensionSchema from "../schemas/extension-v1.schema.json";
import runSchema from "../schemas/run-evidence-v1.schema.json";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  strictTypes: false,
});
for (const schema of [cliSchema, extensionSchema, runSchema])
  ajv.addSchema(schema);

function valid(schemaId: string, value: unknown): boolean {
  const validator = ajv.getSchema(schemaId);
  if (!validator) throw new Error(`missing schema: ${schemaId}`);
  return validator(value) === true;
}

const digest = "a".repeat(64);
const complete = { status: "completed" };
const notRequested = { status: "not_requested" };
const notAssessed = { verdict: "not_assessed" };

const cliResult = {
  format: "sevro.cli-result.v1",
  runId: "run-1",
  execution: complete,
  grading: notRequested,
  task: notAssessed,
  exitCode: 0,
  evidencePath: "/tmp/run.json",
  cases: [
    {
      caseId: "prompt-only",
      execution: complete,
      grading: notRequested,
      task: notAssessed,
      trials: [
        {
          trial: 1,
          execution: complete,
          grading: notRequested,
          task: notAssessed,
          checks: [],
          artifactPath: "/tmp/trial.json",
        },
      ],
    },
  ],
};

test("accepts discovery and each extension operation", () => {
  const envelope = (
    protocol: string,
    method: string,
    field: string,
    body: object,
  ) => ({
    protocol,
    id: "request-1",
    method,
    [field]: body,
  });
  const discovery = "sevro.discovery.v1";
  const extension = "sevro.extension.v1";
  const evalCase = {
    id: "case-1",
    prompt: "Return ready.",
    fixture: { kind: "inline", files: {} },
    checks: [],
    requiredEvidence: [],
    extensionData: {},
  };
  const exchanges = [
    envelope(discovery, "describe", "params", {
      protocols: [extension],
      engineCapabilities: [],
      hostCapabilities: [],
    }),
    envelope(discovery, "describe", "result", {
      extension: { id: "example.policy", version: "1.0.0" },
      protocols: [extension],
      requiredCapabilities: [],
      optionalCapabilities: [],
      graders: [],
      taskVerdictPolicies: [],
    }),
    envelope(extension, "resolve", "params", {
      projectRoot: "file:///tmp/project",
      selectors: {},
      configuration: {},
    }),
    envelope(extension, "resolve", "result", { cases: [evalCase] }),
    envelope(extension, "prepare", "params", {
      case: evalCase,
      host: { id: "sevro.host.codex", capabilities: [] },
      condition: "passive",
      configuration: {},
    }),
    envelope(extension, "prepare", "result", {
      artifacts: [],
      requestedInstrumentation: [],
      extensionData: {},
    }),
    envelope(extension, "evaluate", "params", {
      caseId: "case-1",
      execution: complete,
      observations: [],
      builtinChecks: [],
      artifacts: [],
      extensionData: {},
    }),
    envelope(extension, "evaluate", "result", { checks: [], metrics: [] }),
    envelope(extension, "evaluate", "error", {
      code: "example.unavailable",
      message: "required observation is unavailable",
    }),
  ];
  for (const exchange of exchanges)
    expect(valid("urn:sevro:schema:extension:v1", exchange)).toBe(true);
});

test("rejects ambiguous or incomplete extension messages", () => {
  const base = {
    protocol: "sevro.extension.v1",
    id: "request-1",
    method: "evaluate",
  };
  expect(
    valid("urn:sevro:schema:extension:v1", {
      ...base,
      result: { checks: [], metrics: [] },
      error: { code: "example.error", message: "failed" },
    }),
  ).toBe(false);
  expect(
    valid("urn:sevro:schema:extension:v1", {
      ...base,
      result: { checks: [{ id: "check-1", status: "passed" }], metrics: [] },
    }),
  ).toBe(false);
  expect(
    valid("urn:sevro:schema:extension:v1", {
      ...base,
      params: {},
    }),
  ).toBe(false);
});

test("keeps execution, grading, and task verdict distinct in CLI JSON", () => {
  expect(valid("urn:sevro:schema:cli-result:v1", cliResult)).toBe(true);
  expect(
    valid("urn:sevro:schema:cli-result:v1", {
      ...cliResult,
      grading: { status: "error" },
      task: { verdict: "passed" },
    }),
  ).toBe(false);
  expect(
    valid("urn:sevro:schema:cli-result:v1", {
      ...cliResult,
      execution: { status: "failed" },
      task: { verdict: "passed" },
    }),
  ).toBe(false);
  expect(
    valid("urn:sevro:schema:cli-result:v1", {
      ...cliResult,
      cases: [
        {
          ...cliResult.cases[0],
          trials: [
            {
              ...cliResult.cases[0].trials[0],
              grading: { status: "unavailable" },
              task: { verdict: "passed" },
            },
          ],
        },
      ],
    }),
  ).toBe(false);
  expect(
    valid("urn:sevro:schema:cli-result:v1", {
      ...cliResult,
      execution: { status: "failed" },
      task: { verdict: "failed" },
    }),
  ).toBe(true);
});

test("requires separate runner, project, and extension provenance", () => {
  const evidence = {
    format: "sevro.run-evidence.v1",
    runId: "run-1",
    evaluationIdentity: {
      algorithm: "sevro.identity.v1",
      digest,
      dimensions: {
        runnerBuildDigest: digest,
        projectDigest: digest,
        configurationDigest: digest,
        extensionDigest: null,
        extensionProtocol: null,
        caseDigest: digest,
        fixtureDigest: digest,
        checksDigest: digest,
        requiredEvidenceDigest: digest,
        evaluatorDigest: digest,
        graderDigest: digest,
        instrumentationDigest: digest,
        routeDigest: digest,
        condition: "passive",
        trialCount: 1,
        passThreshold: 1,
      },
    },
    configuration: { digest, redacted: {} },
    runner: {
      source: "package",
      packageName: "sevro",
      version: "0.1.0",
      buildDigest: digest,
    },
    project: {
      root: "file:///tmp/project",
      revision: null,
      dirtyPatchDigest: null,
    },
    extension: null,
    condition: {
      requested: "passive",
      actual: "passive",
      requestedInstrumentation: [],
      appliedInstrumentation: [],
    },
    graders: { active: [], replacedDefaults: [] },
    routes: [],
    result: cliResult,
    trials: [
      {
        caseId: "prompt-only",
        trial: 1,
        executionMode: "executed",
        condition: {
          requested: "passive",
          actual: "passive",
          appliedInstrumentation: [],
        },
        observationCompleteness: "complete",
        observations: [],
        routes: [],
        usage: {
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          complete: false,
        },
        rawResult: { source: "synthetic", path: null, sha256: null },
        artifactRefs: [],
      },
    ],
  };
  expect(valid("urn:sevro:schema:run-evidence:v1", evidence)).toBe(true);
  expect(
    valid("urn:sevro:schema:run-evidence:v1", {
      ...evidence,
      runner: { version: "0.1.0" },
    }),
  ).toBe(false);
  const { instrumentationDigest: _missing, ...incompleteDimensions } =
    evidence.evaluationIdentity.dimensions;
  expect(
    valid("urn:sevro:schema:run-evidence:v1", {
      ...evidence,
      evaluationIdentity: {
        ...evidence.evaluationIdentity,
        dimensions: incompleteDimensions,
      },
    }),
  ).toBe(false);
});
