import { expect, test } from "bun:test";
import fc from "fast-check";
import schema from "../schemas/extension-v1.schema.json";
import validate from "../src/generated/extension.cjs";
import {
  requiredMutationPaths,
  typedMutations,
  constraintMutations,
  optionalMutationPaths,
  remove,
  replace,
} from "./quality-fixtures/schema-boundaries";

const digest = "a".repeat(64);
const configuration = { feature: { enabled: true, values: [1, "two", null] } };
const extensionData = { "example.context": { opaque: [true, 1, "ready"] } };
const route = {
  id: "sevro.host.codex",
  model: "synthetic",
  effort: "low",
  capabilities: ["sevro.host.continuation"],
};
const evalCase = {
  id: "case-1",
  prompt: "Return READY.",
  followUpPrompt: "Retain READY.",
  fixture: {
    kind: "generated",
    commits: [{ message: "initialize", files: { "README.md": "ready\n" } }],
    files: { "README.md": "overlay\n" },
    staged: ["README.md"],
    commitFiles: true,
    hooks: { "pre-commit": "#!/bin/sh\nexit 0\n" },
    bin: { tool: "#!/bin/sh\nexit 0\n" },
  },
  checks: [
    { id: "ready", grader: "sevro.regex", configuration: { pattern: "READY" } },
  ],
  requiredEvidence: ["example.observation"],
  extensionData,
};
const prepareResult = {
  artifacts: [
    {
      id: "inline",
      relativePath: "tool.sh",
      sha256: digest,
      contentBase64: "cmVhZHk=",
      executable: true,
      gitExclude: true,
    },
    {
      id: "source",
      relativePath: "policy.txt",
      sha256: digest,
      sourceRef: "declared-source",
      executable: false,
      gitExclude: false,
    },
  ],
  requestedInstrumentation: [{ id: "example.enforcement", configuration }],
  fixtureSetup: {
    command: ["/bin/sh", "-c", "printf ready"],
    environment: { CASE_ROOT: "{{sevro.project}}/cases" },
  },
  codexMarketplace: {
    artifactRoot: "plugins",
    marketplaceName: "example",
    pluginNames: ["policy"],
  },
  codexSkillInvocation: { pluginName: "policy", skillName: "review" },
  extensionData,
};
const evaluateParams = {
  caseId: "case-1",
  execution: { status: "completed", errorCode: "example.diagnostic" },
  observations: [
    {
      id: "example.observation",
      source: "host",
      completeness: "complete",
      data: configuration,
    },
  ],
  builtinChecks: [
    {
      id: "ready",
      status: "passed",
      detail: "ready",
      evidenceRefs: ["observation"],
    },
  ],
  artifacts: [
    {
      id: "artifact",
      path: "file:///tmp/artifact",
      sha256: digest,
      gitExclude: true,
      executable: false,
    },
  ],
  extensionData,
  selectedTaskVerdictPolicy: "example.policy",
  configuration,
};
const evaluateResult = {
  checks: [
    {
      id: "example.check",
      status: "passed",
      detail: "validated",
      evidenceRefs: ["observation"],
    },
  ],
  metrics: [
    { id: "example.duration", value: 2.5, unit: "seconds" },
    { id: "example.unknown", value: null, unit: "count" },
  ],
  domainOutcomes: [
    {
      id: "example.domain",
      status: "unavailable",
      evidenceRefs: [],
      detail: "independent",
      data: configuration,
    },
  ],
  taskVerdictRecommendation: "passed",
};

const variants = [
  {
    method: "describe",
    field: "params",
    definition: "describeParams",
    body: {
      protocols: ["sevro.extension.v1"],
      engineCapabilities: ["example.engine"],
      hostCapabilities: ["example.host"],
    },
  },
  {
    method: "describe",
    field: "result",
    definition: "describeResult",
    body: {
      extension: { id: "example.policy", version: "1.0.0" },
      protocols: ["sevro.extension.v1"],
      requiredCapabilities: ["example.required"],
      optionalCapabilities: ["example.optional"],
      graders: ["example.grader"],
      taskVerdictPolicies: ["example.policy"],
    },
  },
  {
    method: "resolve",
    field: "params",
    definition: "resolveParams",
    body: {
      projectRoot: "file:///tmp/project",
      selectors: { caseIds: ["case-1"], skill: "review", plugin: "policy" },
      configuration,
      host: route,
    },
  },
  {
    method: "resolve",
    field: "result",
    definition: "resolveResult",
    body: {
      cases: [
        evalCase,
        {
          ...evalCase,
          fixture: { kind: "inline", files: { "file.txt": "inline" } },
        },
        {
          ...evalCase,
          fixture: {
            kind: "repository",
            sourceRef: "declared-repo",
            files: {},
            staged: [],
            commitFiles: false,
            hooks: {},
            bin: {},
          },
        },
      ],
    },
  },
  {
    method: "prepare",
    field: "params",
    definition: "prepareParams",
    body: {
      case: evalCase,
      host: { id: route.id, capabilities: route.capabilities },
      condition: "enforced",
      configuration,
    },
  },
  {
    method: "prepare",
    field: "result",
    definition: "prepareResult",
    body: prepareResult,
  },
  {
    method: "evaluate",
    field: "params",
    definition: "evaluateParams",
    body: evaluateParams,
  },
  {
    method: "evaluate",
    field: "result",
    definition: "evaluateResult",
    body: evaluateResult,
  },
];

function envelope(method: string, field: string, body: unknown) {
  return {
    protocol:
      method === "describe" ? "sevro.discovery.v1" : "sevro.extension.v1",
    id: "request-1",
    method,
    [field]: body,
  };
}

test("extension contracts refuse duplicate capabilities, undeclared fields and declared bounds", () => {
  for (const variant of variants) {
    const bodySchema = { $ref: `#/$defs/${variant.definition}` };
    for (const { path, replacement } of constraintMutations(
      bodySchema,
      variant.body,
      schema,
    )) {
      const body = replace(variant.body, path, replacement);
      expect(
        validate(envelope(variant.method, variant.field, body)),
        `${variant.definition}:${JSON.stringify(path)}`,
      ).toBe(false);
    }
  }
});

test("extension callers can omit each declared optional configuration and evidence field", () => {
  for (const variant of variants) {
    const bodySchema = { $ref: `#/$defs/${variant.definition}` };
    for (const path of optionalMutationPaths(
      bodySchema,
      variant.body,
      schema,
    )) {
      const body = remove(variant.body, path);
      expect(
        validate(envelope(variant.method, variant.field, body)),
        `${variant.definition}:${JSON.stringify(path)}`,
      ).toBe(true);
    }
  }
});

test("extension v1 rich requests and responses retain required fields and typed boundaries", () => {
  for (const variant of variants) {
    const message = envelope(variant.method, variant.field, variant.body);
    expect(validate(message), variant.definition).toBe(true);
    const bodySchema = { $ref: `#/$defs/${variant.definition}` };
    for (const path of requiredMutationPaths(
      bodySchema,
      variant.body,
      schema,
    )) {
      expect(
        validate(
          envelope(variant.method, variant.field, remove(variant.body, path)),
        ),
        `${variant.definition}:${JSON.stringify(path)}`,
      ).toBe(false);
    }
    for (const { path, replacement } of typedMutations(
      bodySchema,
      variant.body,
      schema,
    )) {
      expect(
        validate(
          envelope(
            variant.method,
            variant.field,
            replace(variant.body, path, replacement),
          ),
        ),
        `${variant.definition}:${JSON.stringify(path)}`,
      ).toBe(false);
    }
  }
});

test("extension responses preserve opaque JSON data but refuse ambiguous success and error", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (payload) => {
      const body = {
        ...evaluateResult,
        domainOutcomes: [
          { ...evaluateResult.domainOutcomes[0], data: { payload } },
        ],
      };
      const message = envelope("evaluate", "result", body);
      expect(validate(message)).toBe(true);
      expect(
        validate({
          ...message,
          error: { code: "example.failure", message: "refused" },
        }),
      ).toBe(false);
    }),
    { seed: 20261007, numRuns: 200, endOnFailure: true },
  );
});

test("each extension operation represents refusal without claiming a result", () => {
  for (const method of ["describe", "resolve", "prepare", "evaluate"]) {
    const message = envelope(method, "error", {
      code: "example.refusal",
      message: "unavailable",
    });
    expect(validate(message)).toBe(true);
    expect(validate({ ...message, result: {} })).toBe(false);
    expect(
      validate(
        envelope(method, "error", { code: "unnamespaced", message: "" }),
      ),
    ).toBe(false);
  }
});

test("passed extension checks require evidence and detail is bounded", () => {
  expect(
    validate(
      envelope("evaluate", "result", {
        ...evaluateResult,
        checks: [{ id: "example.check", status: "passed", evidenceRefs: [] }],
      }),
    ),
  ).toBe(false);
  expect(
    validate(
      envelope("evaluate", "result", {
        ...evaluateResult,
        checks: [
          {
            id: "example.check",
            status: "failed",
            evidenceRefs: [],
            detail: "x".repeat(4096),
          },
        ],
      }),
    ),
  ).toBe(true);
  expect(
    validate(
      envelope("evaluate", "result", {
        ...evaluateResult,
        checks: [
          {
            id: "example.check",
            status: "failed",
            evidenceRefs: [],
            detail: "x".repeat(4097),
          },
        ],
      }),
    ),
  ).toBe(false);
});
