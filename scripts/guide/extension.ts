import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionRequest } from "../../src/extension-client";
import type {
  EvaluationRequest,
  ExtensionCase,
  PreparationResult,
} from "../../src/extension-session";
import validExchange from "../../src/generated/extension.cjs";
import { isRecord, isStringArray } from "../../src/value-guards";
import { casesPath, guideFixture, guideRoot } from "./fixture";
import {
  eventArtifact,
  gradeGuide,
  guideChecks,
  guideCheckId,
  invocationObservation,
  workspaceObservation,
} from "./grading";
import { parseGuideCases } from "./records";
import type { GuideCase, Host } from "./types";

function selectedHost(value: unknown): Host {
  if (!isRecord(value) || !isStringArray(value.capabilities))
    throw new Error("Missing guide host route");
  if (value.id === "sevro.host.codex") return "codex";
  if (value.id === "sevro.host.claude") return "claude";
  throw new Error("Guide evaluations require a Codex or Claude host route");
}

async function resolvedCase(
  test: GuideCase,
  host: Host,
): Promise<ExtensionCase> {
  const { files } = await guideFixture(test.fixture);
  const explicit = test.prompt.startsWith("$sevro-guide");
  const requiredEvidence = [
    eventArtifact(host, "initial", Boolean(test.followUp)),
    workspaceObservation,
  ];
  if (test.followUp)
    requiredEvidence.push(eventArtifact(host, "follow-up", true));
  if (explicit) requiredEvidence.push(invocationObservation(host));
  return {
    id: test.id,
    prompt: test.prompt.replace(/^\$sevro-guide/, "{{sevro.skill_invocation}}"),
    ...(test.followUp ? { followUpPrompt: test.followUp } : {}),
    fixture: {
      kind: "generated",
      commits: [{ message: "Guide evaluation fixture", files }],
    },
    checks: guideChecks(test).map((name) => ({
      id: guideCheckId(name),
      grader: "sevro.guide.assessment",
      configuration: {},
    })),
    requiredEvidence,
    extensionData: { "sevro.guide.case": test, "sevro.guide.host": host },
  };
}

async function resolveCases(params: Record<string, unknown>) {
  const host = selectedHost(params.host);
  const selectors = isRecord(params.selectors)
    ? params.selectors.caseIds
    : undefined;
  if (!isStringArray(selectors) || !selectors.length)
    throw new Error("Guide evaluation requires case IDs");
  const cases = parseGuideCases(
    await readFile(join(guideRoot, casesPath), "utf8"),
  );
  const selected = selectors.map((id) => {
    const test = cases.find((item) => item.id === id);
    if (!test) throw new Error("Unknown guide case: " + id);
    return test;
  });
  return {
    cases: await Promise.all(selected.map((test) => resolvedCase(test, host))),
  };
}

async function prepareCase(
  params: Record<string, unknown>,
): Promise<PreparationResult> {
  if (!isRecord(params.case) || !isRecord(params.case.extensionData))
    throw new Error("Invalid guide preparation case");
  const [test] = parseGuideCases(
    JSON.stringify([params.case.extensionData["sevro.guide.case"]]),
  );
  if (!test) throw new Error("Missing guide preparation case");
  const host = selectedHost(params.host);
  const { artifacts } = await guideFixture(test.fixture);
  const explicit = test.prompt.startsWith("$sevro-guide");
  return {
    artifacts,
    requestedInstrumentation: [],
    ...(explicit ? repositoryInvocation(host) : {}),
    extensionData: { "sevro.guide.case": test, "sevro.guide.host": host },
  };
}

function repositoryInvocation(host: Host) {
  return host === "codex"
    ? { codexRepositorySkillInvocation: { skillName: "sevro-guide" } }
    : { claudeRepositorySkillInvocation: { skillName: "sevro-guide" } };
}

async function response(request: ExtensionRequest): Promise<object> {
  switch (request.method) {
    case "describe":
      return {
        extension: { id: "sevro.guide", version: "2.0.0" },
        protocols: ["sevro.extension.v1"],
        requiredCapabilities: ["sevro.case.host-route"],
        optionalCapabilities: [
          "sevro.host.continuation",
          "sevro.codex.repository-invocation",
          "sevro.claude.repository-invocation",
        ],
        graders: ["sevro.guide.assessment"],
        taskVerdictPolicies: [],
      };
    case "resolve":
      return resolveCases(request.params);
    case "prepare":
      return prepareCase(request.params);
    case "evaluate":
      return gradeGuide(request.params as unknown as EvaluationRequest);
  }
}

const input: unknown = JSON.parse(await Bun.stdin.text());
if (
  !validExchange(input) ||
  !isRecord(input) ||
  !Object.hasOwn(input, "params")
)
  throw new Error("Invalid guide extension request");
const request = input as unknown as ExtensionRequest;
process.stdout.write(
  JSON.stringify({
    protocol: request.protocol,
    id: request.id,
    method: request.method,
    result: await response(request),
  }),
);
