import { join } from "node:path";
import type {
  EvaluationRequest,
  ExtensionCase,
  ExtensionSessionOptions,
} from "../../src/extension-session";

export const wireCase = {
  id: "wire-case",
  prompt: "Return ready.",
  fixture: { kind: "inline", files: { "README.md": "wire fixture\n" } },
  checks: [
    {
      id: "example.extension.ready",
      grader: "example.extension",
      configuration: {},
    },
  ],
  requiredEvidence: [],
  extensionData: {},
} satisfies ExtensionCase;

export function wireOptions(
  overrides: Record<string, unknown> = {},
): ExtensionSessionOptions {
  const fixture = join(import.meta.dir, "quality-engine-extension.ts");
  const result = {
    describe: {
      extension: { id: "example.extension", version: "1.0.0" },
      protocols: ["sevro.extension.v1"],
      requiredCapabilities: [],
      optionalCapabilities: [],
      graders: ["example.extension"],
      taskVerdictPolicies: ["example.policy"],
    },
    resolve: { cases: [wireCase] },
    prepare: { artifacts: [], requestedInstrumentation: [], extensionData: {} },
    evaluate: {
      checks: [
        {
          id: "example.extension.ready",
          status: "passed",
          evidenceRefs: ["example.evidence"],
        },
      ],
      metrics: [],
    },
    ...overrides,
  };
  return {
    command: [process.execPath, fixture, JSON.stringify(result)],
    sourceFiles: [fixture],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: [],
    hostCapabilities: [],
  };
}

export function wireEvaluationRequest(): EvaluationRequest {
  return {
    caseId: wireCase.id,
    execution: { status: "completed" },
    observations: [
      {
        id: "example.evidence",
        source: "example.host",
        completeness: "complete",
        data: {},
      },
    ],
    builtinChecks: [],
    artifacts: [],
    extensionData: {},
  };
}
