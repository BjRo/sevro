import type { RunEvidenceData } from "../../src/schema-types";
import { richCli, richEvidence } from "./rich-schema-results";
import { defined } from "../fixtures/assertions";

export type ExtensionDocument = {
  name: string;
  method: string;
  field: "params" | "result" | "error";
  definition: string;
  body: unknown;
};
const digest = "a".repeat(64);
const extensionData = {
  "example.context": { opaque: [null, true, 2, "unchanged"] },
};
const configuration = {
  nested: { enabled: false, values: [null, 0, "ready"] },
};
export function exchange(
  document: ExtensionDocument,
  body: unknown = document.body,
) {
  return {
    protocol:
      document.method === "describe"
        ? "sevro.discovery.v1"
        : "sevro.extension.v1",
    id: "request-1",
    method: document.method,
    [document.field]: body,
  };
}
const overlays = {
  files: { "README.md": "overlay", "nested/file.txt": "second" },
  staged: ["README.md", "nested/file.txt"],
  commitFiles: false,
  hooks: {
    "pre-commit": "#!/bin/sh\nexit 0",
    "post-checkout": "#!/bin/sh\nexit 0",
  },
  bin: { probe: "#!/bin/sh\nexit 0", helper: "#!/bin/sh\nexit 0" },
};
export const fixtureCases = [
  {
    kind: "inline",
    files: { "README.md": "inline", "nested/file.txt": "second" },
  },
  { kind: "repository", sourceRef: "declared-repository", ...overlays },
  {
    kind: "generated",
    commits: [
      {
        message: "initial",
        files: { "README.md": "ready", "other.txt": "second" },
      },
      { message: "change", files: { "README.md": "changed" } },
    ],
    ...overlays,
  },
];
export function resolvedCase(fixture: unknown) {
  return {
    id: "case-1",
    prompt: "Return ready",
    followUpPrompt: "Continue in this session",
    fixture,
    checks: [{ id: "ready", grader: "sevro.regex", configuration }],
    requiredEvidence: ["example.first", "example.second"],
    extensionData,
  };
}
const artifacts = [
  {
    id: "inline",
    relativePath: "tools/probe",
    sha256: digest,
    contentBase64: "cmVhZHk=",
    gitExclude: true,
    executable: true,
  },
  {
    id: "external",
    relativePath: "assets/policy",
    sha256: digest,
    sourceRef: "declared-policy",
    gitExclude: false,
    executable: false,
  },
];
const preparation = {
  artifacts,
  requestedInstrumentation: [
    { id: "example.probe", configuration },
    { id: "example.other", configuration: {} },
  ],
  fixtureSetup: {
    command: ["/bin/sh", "-c", "printf ready"],
    environment: {
      PROJECT: "{{sevro.project}}",
      WORKSPACE: "{{sevro.workspace}}",
    },
  },
  extensionData,
};
const invocationVariants = [
  {
    name: "Codex marketplace",
    extras: {
      codexMarketplace: {
        artifactRoot: "plugins",
        marketplaceName: "probe",
        pluginNames: ["probe", "helper"],
      },
      codexSkillInvocation: { pluginName: "probe", skillName: "review" },
    },
  },
  {
    name: "Codex repository skill",
    extras: { codexRepositorySkillInvocation: { skillName: "review" } },
  },
  {
    name: "Claude plugin directories",
    extras: {
      claudePluginDirs: { artifactRoots: ["plugins/probe", "plugins/helper"] },
      claudeSkillInvocation: { pluginName: "probe", skillName: "review" },
    },
  },
  {
    name: "Claude repository skill",
    extras: { claudeRepositorySkillInvocation: { skillName: "review" } },
  },
];
function namedResult(
  name: string,
  method: string,
  definition: string,
  body: unknown,
): ExtensionDocument {
  return { name, method, definition, field: "result", body };
}
export function extensionDocuments(
  source: RunEvidenceData,
): ExtensionDocument[] {
  return [
    ...discoveryDocuments(),
    ...fixtureCases.map((fixture) =>
      namedResult(`resolved ${fixture.kind}`, "resolve", "resolveResult", {
        cases: [resolvedCase(fixture)],
      }),
    ),
    ...fixtureCases.map((fixture) => ({
      name: `prepare ${fixture.kind}`,
      method: "prepare",
      field: "params" as const,
      definition: "prepareParams",
      body: {
        case: resolvedCase(fixture),
        host: {
          id: "sevro.host.synthetic",
          capabilities: ["sevro.fixture.setup", "sevro.host.continuation"],
        },
        condition: "passive",
        configuration,
      },
    })),
    ...invocationVariants.map(({ name, extras }) =>
      namedResult(name, "prepare", "prepareResult", {
        ...preparation,
        ...extras,
      }),
    ),
    {
      name: "retained trial evaluation",
      method: "evaluate",
      field: "params",
      definition: "evaluateParams",
      body: evaluationRequest(source),
    },
    namedResult(
      "evaluated outcomes",
      "evaluate",
      "evaluateResult",
      evaluationResult(source),
    ),
    ...["describe", "resolve", "prepare", "evaluate"].map((method) => ({
      name: `${method} refusal`,
      method,
      field: "error" as const,
      definition: "error",
      body: {
        code: "example.refused",
        message: "Unavailable evidence cannot establish success",
      },
    })),
  ];
}

function discoveryDocuments(): ExtensionDocument[] {
  const protocols = ["sevro.extension.v1", "sevro.extension.v12"];
  return [
    {
      name: "discovery capabilities",
      method: "describe",
      field: "params",
      definition: "describeParams",
      body: {
        protocols,
        engineCapabilities: ["sevro.fixture.setup", "example.engine"],
        hostCapabilities: ["sevro.host.continuation", "example.host"],
      },
    },
    namedResult("extension negotiation", "describe", "describeResult", {
      extension: { id: "example.policy", version: "1.0.0" },
      protocols,
      requiredCapabilities: ["sevro.fixture.setup", "sevro.host.continuation"],
      optionalCapabilities: ["example.future", "example.other"],
      graders: ["example.first", "example.second"],
      taskVerdictPolicies: ["example.policy", "example.other-policy"],
    }),
  ];
}
function evaluationRequest(source: RunEvidenceData) {
  const retained = richEvidence(source),
    trial = defined(retained.trials[0]);
  const result = richCli(source.result),
    resultTrial = defined(defined(result.cases[0]).trials[0]);
  return {
    caseId: trial.caseId,
    execution: resultTrial.execution,
    observations: trial.observations,
    builtinChecks: [
      {
        id: "ready",
        status: "failed",
        detail: "Independent assertion failed",
        evidenceRefs: ["first", "second"],
      },
    ],
    artifacts: trial.artifactRefs,
    selectedTaskVerdictPolicy: "example.policy",
    extensionData,
    configuration,
  };
}
function evaluationResult(source: RunEvidenceData) {
  const trial = defined(richEvidence(source).trials[0]);
  return {
    checks: [
      {
        id: "example.first",
        status: "passed",
        detail: "Verified evidence",
        evidenceRefs: ["first", "second"],
      },
      {
        id: "example.second",
        status: "failed",
        detail: "Independent failure",
        evidenceRefs: [],
      },
      {
        id: "example.third",
        status: "unavailable",
        detail: "Missing observation",
        evidenceRefs: [],
      },
    ],
    metrics: trial.metrics,
    domainOutcomes: trial.domainOutcomes,
    taskVerdictRecommendation: "not_assessed",
  };
}
