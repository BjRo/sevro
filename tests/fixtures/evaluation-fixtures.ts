import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openExtensionSession } from "../../src/extension-session";
import { wireCase, wireOptions } from "./engine-session";
import { type EvaluationOptions, type HostResult } from "../../src/engine";
import { defined } from "./assertions";

export function createEvaluation(roots: string[]) {
  async function evaluation(result: HostResult): Promise<EvaluationOptions> {
    const root = await mkdtemp(join(tmpdir(), "sevro-engine-quality-"));
    roots.push(root);
    return {
      projectRoot: root,
      resultsRoot: join(root, "results"),
      runnerBuildDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
      case: {
        id: "ready",
        prompt: "Return ready.",
        fixture: { files: { "README.md": "independent fixture\n" } },
        checks: [
          {
            id: "response",
            grader: "sevro.regex",
            configuration: { pattern: "^ready$" },
          },
        ],
        requiredEvidence: [],
      },
      host: {
        id: "example.host",
        model: "fixture-v1",
        effort: "none",
        run: () => Promise.resolve(result),
      },
    };
  }
  return evaluation;
}

export function observation(id: string) {
  return { id, completeness: "complete" as const, data: { ready: true } };
}

export function requireSemantic(
  options: EvaluationOptions,
  result: HostResult,
): void {
  options.case.checks = [
    {
      id: "meaning",
      grader: "sevro.semantic",
      configuration: { proposition: "The response confirms readiness." },
    },
  ];
  options.semanticHost = {
    id: "example.semantic-host",
    model: "grader-v1",
    effort: "none",
    run: () => Promise.resolve(result),
  };
}

export function createExtensionEvaluation(
  evaluation: ReturnType<typeof createEvaluation>,
) {
  async function extensionEvaluation(
    responses: Record<string, unknown> = {},
    engineCapabilities: string[] = [],
  ): Promise<EvaluationOptions> {
    const options = await evaluation({
      finalMessage: "ready",
      complete: true,
      observations: [observation("example.evidence")],
    });
    const sessionOptions = wireOptions(responses);
    sessionOptions.engineCapabilities = engineCapabilities;
    const session = await openExtensionSession(sessionOptions);
    const resolved = defined(
      (await session.resolve(pathToFileURL(options.projectRoot).href, {}))[0],
    );
    if (resolved.fixture.kind !== "inline")
      throw new Error("Expected inline wire fixture");
    options.case = { ...resolved, fixture: { files: resolved.fixture.files } };
    options.extension = { session, resolvedCase: resolved };
    return options;
  }
  return extensionEvaluation;
}

export function createSetupEvaluation(
  evaluation: ReturnType<typeof createEvaluation>,
) {
  async function setupEvaluation(
    command: string[],
    preparation: Record<string, unknown> = {},
    checks: EvaluationOptions["case"]["checks"] = [],
  ): Promise<EvaluationOptions> {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    const fixture = {
      kind: "generated" as const,
      commits: [
        { message: "Setup baseline", files: { "README.md": "baseline\n" } },
      ],
    };
    const sessionOptions = wireOptions({
      describe: {
        extension: { id: "example.extension", version: "1.0.0" },
        protocols: ["sevro.extension.v1"],
        requiredCapabilities: ["sevro.fixture.setup"],
        optionalCapabilities: [],
        graders: ["example.extension"],
        taskVerdictPolicies: [],
      },
      resolve: {
        cases: [
          { ...wireCase, fixture, checks: [...wireCase.checks, ...checks] },
        ],
      },
      prepare: {
        artifacts: [],
        requestedInstrumentation: [],
        fixtureSetup: { command },
        extensionData: {},
        ...preparation,
      },
    });
    sessionOptions.engineCapabilities = ["sevro.fixture.setup"];
    const session = await openExtensionSession(sessionOptions);
    const resolvedCase = defined(
      (await session.resolve(pathToFileURL(options.projectRoot).href, {}))[0],
    );
    options.case = { ...resolvedCase, fixture };
    options.extension = { session, resolvedCase };
    return options;
  }
  return setupEvaluation;
}
