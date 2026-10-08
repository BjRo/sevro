import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionRequest } from "../../src/extension-client";
import type {
  EvaluationRequest,
  EvaluationResult,
  ExtensionCase,
} from "../../src/extension-session";
import {
  gradeOutput,
  prepareOutputChecks,
  type OutputCheckDeclaration,
} from "../../src/graders/output";
import validExchange from "../../src/generated/extension.cjs";
import { summarizeCodexEvents } from "../../src/hosts/codex-events";
import { summarizeClaudeEvents } from "../../src/hosts/claude-events";
import {
  isRecord,
  isStringArray,
  isUnknownArray,
} from "../../src/value-guards";
import {
  effectAttempts,
  inspectedSources,
  usedGuide,
  type Turn,
} from "./evidence";
import {
  casesPath,
  fixtureCheck,
  guideFixture,
  guidePath,
  guideRoot,
} from "./fixture";

type Host = "codex" | "claude";
const prefix = "sevro.guide.";
type Observation = EvaluationRequest["observations"][number];

function hostRoute(value: unknown): Host {
  if (!isRecord(value)) throw new Error("Missing guide host route");
  if (value.id === "sevro.host.codex") return "codex";
  if (value.id === "sevro.host.claude") return "claude";
  throw new Error("Guide evals require a Codex or Claude adapter");
}

function definition(value: unknown): ExtensionCase {
  if (!isRecord(value)) throw new Error("Invalid guide case");
  const candidate = {
    ...value,
    fixture: { kind: "inline", files: {} },
    requiredEvidence: [],
  };
  const envelope = {
    protocol: "sevro.extension.v1",
    id: "guide-definition",
    method: "resolve",
    result: { cases: [candidate] },
  };
  if (!validExchange(envelope))
    throw new Error("Invalid guide case definition");
  return candidate as unknown as ExtensionCase;
}

async function definitions(): Promise<ExtensionCase[]> {
  const value: unknown = JSON.parse(
    await readFile(join(guideRoot, casesPath), "utf8"),
  );
  if (!isUnknownArray(value)) throw new Error("Invalid guide case inventory");
  return value.map(definition);
}

function eventId(host: Host, followUp: boolean, initial: boolean): string {
  if (followUp) return "sevro." + host + ".follow-up-events";
  if (initial && host === "claude") return "sevro.claude.initial-events";
  return "sevro." + host + ".events";
}

function selectionId(host: Host, data: Record<string, unknown>): string {
  if (data[prefix + "explicit"])
    return host === "codex"
      ? "sevro.codex.explicit-invocation"
      : "sevro.claude.repository-invocation";
  return host === "codex"
    ? "sevro.codex.skill-reads"
    : "sevro.claude.tool-calls";
}

function customNames(test: ExtensionCase): string[] {
  const names = ["selection", "no-effects"];
  if (test.extensionData[prefix + "inspect-citation"])
    names.push("inspected-citation");
  if (test.extensionData[prefix + "inspect-sources"])
    names.push("inspected-sources");
  if (test.followUpPrompt) names.push("follow-up-citation", "initial-output");
  return names;
}

function fixtureKind(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value !== "missing" && value !== "conflict" && value !== "stale")
    throw new Error("Invalid guide fixture variant");
  return value;
}

async function resolveCases(params: Record<string, unknown>) {
  const host = hostRoute(params.host);
  const selectors = isRecord(params.selectors)
    ? params.selectors.caseIds
    : undefined;
  if (!isStringArray(selectors)) throw new Error("Missing guide case IDs");
  const cases = await definitions();
  const selected = selectors.map((id) => {
    const test = cases.find((item) => item.id === id);
    if (!test) throw new Error("Unknown guide case: " + id);
    return test;
  });
  return {
    cases: await Promise.all(selected.map((test) => resolveCase(test, host))),
  };
}

async function resolveCase(
  test: ExtensionCase,
  host: Host,
): Promise<ExtensionCase> {
  const fixture = await guideFixture(
    fixtureKind(test.extensionData[prefix + "fixture"]),
  );
  const requiredEvidence = [
    eventId(host, false, Boolean(test.followUpPrompt)),
    selectionId(host, test.extensionData),
  ];
  if (test.followUpPrompt)
    requiredEvidence.push(
      eventId(host, true, false),
      "sevro." + host + ".continuation",
    );
  return {
    ...test,
    fixture: {
      kind: "generated",
      commits: [{ message: "Guide evaluation fixture", files: fixture.files }],
    },
    checks: [
      ...test.checks,
      fixtureCheck(fixture),
      ...customNames(test).map((name) => ({
        id: prefix + name,
        grader: "sevro.guide.evidence",
        configuration: {},
      })),
    ],
    requiredEvidence,
    extensionData: { ...test.extensionData, [prefix + "host"]: host },
  };
}

async function prepareCase(params: Record<string, unknown>) {
  const test = definition(params.case);
  const host = hostRoute(params.host);
  const fixture = await guideFixture(
    fixtureKind(test.extensionData[prefix + "fixture"]),
  );
  const invocation =
    host === "codex"
      ? { codexRepositorySkillInvocation: { skillName: "sevro-guide" } }
      : { claudeRepositorySkillInvocation: { skillName: "sevro-guide" } };
  return {
    artifacts: fixture.artifacts,
    requestedInstrumentation: [],
    ...(test.extensionData[prefix + "explicit"] ? invocation : {}),
    extensionData: test.extensionData,
  };
}

function completeObservation(
  request: EvaluationRequest,
  id: string,
): Observation | undefined {
  return request.observations.find(
    (item) => item.id === id && item.completeness === "complete",
  );
}

async function retainedTurn(
  request: EvaluationRequest,
  host: Host,
  id: string,
): Promise<Turn | undefined> {
  const artifact = request.artifacts.find((item) => item.id === id);
  if (!artifact) return undefined;
  const bytes = await artifactBytes(artifact);
  return parsedTurn(host, bytes.toString("utf8"));
}
async function artifactBytes(
  artifact: EvaluationRequest["artifacts"][number],
): Promise<Buffer> {
  const path = new URL(artifact.path);
  if (path.protocol !== "file:" || (await stat(path)).size > 8 * 1024 * 1024)
    throw new Error("Invalid guide event artifact");
  const bytes = await readFile(path);
  if (bytes.byteLength > 8 * 1024 * 1024)
    throw new Error("Oversized guide event artifact");
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
    throw new Error("Guide artifact digest differs");
  return bytes;
}
function parsedTurn(host: Host, text: string): Turn | undefined {
  const summary =
    host === "codex"
      ? summarizeCodexEvents(text, 0)
      : summarizeClaudeEvents(text, 0);
  if (!summary.complete || summary.finalMessage === null) return undefined;
  const events = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error("Invalid guide event");
      return value;
    });
  return { answer: summary.finalMessage, events };
}

function explicitSelection(receipt: Observation, host: Host): boolean {
  if (host === "codex")
    return (
      receipt.data.method === "explicit_invocation" &&
      receipt.data.primarySkill === "sevro-guide"
    );
  return receipt.data.accepted === true && receipt.data.skill === "sevro-guide";
}

async function selection(
  receipt: Observation,
  host: Host,
  data: Record<string, unknown>,
  first: Turn,
) {
  if (typeof data[prefix + "activation"] !== "boolean")
    throw new Error("Missing guide activation expectation");
  let selected: boolean;
  if (data[prefix + "explicit"]) selected = explicitSelection(receipt, host);
  else if (host === "codex")
    selected =
      isStringArray(receipt.data.observedSkills) &&
      receipt.data.observedSkills.includes("sevro-guide");
  else
    selected = usedGuide(
      first,
      (await readFile(join(guideRoot, guidePath), "utf8")).trim(),
    );
  return selected === data[prefix + "activation"];
}

function cited(turn: Turn): boolean {
  return inspectedSources(turn).some((path) => turn.answer.includes(path));
}

function initialOutput(data: Record<string, unknown>, first: Turn): boolean {
  const value = data[prefix + "initial-output"];
  const validated = definition({
    id: "initial",
    prompt: "initial",
    checks: value,
    extensionData: {},
  });
  const checks = prepareOutputChecks(
    validated.checks as OutputCheckDeclaration[],
  );
  return gradeOutput(first.answer, true, checks).every(
    (check) => check.status === "passed",
  );
}

async function gradeGuide(
  request: EvaluationRequest,
): Promise<EvaluationResult> {
  const { data, host, test, first, follow, firstId, receiptId, receipt } =
    await guideEvidence(request);
  if (!first || !receipt) return unavailable(test);
  if (test.followUpPrompt && !follow) return unavailable(test);
  const values: Record<string, boolean> = {
    selection: await selection(receipt, host, data, first),
    "no-effects": effectAttempts(first).length === 0,
    ...sourceChecks(data, first),
    ...followChecks(data, first, follow),
  };
  const refs = evidenceRefs(host, firstId, receiptId, follow);
  return {
    checks: customNames(test).map((name) => ({
      id: prefix + name,
      status: values[name] ? "passed" : "failed",
      evidenceRefs: refs,
    })),
    metrics: [],
  };
}
async function guideEvidence(request: EvaluationRequest) {
  const data = request.extensionData,
    host = evidenceHost(data);
  const test = (await definitions()).find((item) => item.id === request.caseId);
  if (!test) throw new Error("Unknown guide evidence case");
  const firstId = eventId(host, false, Boolean(test.followUpPrompt));
  const first = await retainedTurn(request, host, firstId);
  const follow = test.followUpPrompt
    ? await retainedTurn(request, host, eventId(host, true, false))
    : undefined;
  const receiptId = selectionId(host, data),
    receipt = completeObservation(request, receiptId);
  return { data, host, test, first, follow, firstId, receiptId, receipt };
}
function evidenceHost(data: Record<string, unknown>): Host {
  const host = data[prefix + "host"];
  if (host !== "codex" && host !== "claude")
    throw new Error("Invalid guide evidence host");
  return host;
}
function followChecks(
  data: Record<string, unknown>,
  first: Turn,
  follow: Turn | undefined,
): Record<string, boolean> {
  if (!follow) return {};
  return {
    "no-effects":
      effectAttempts(first).length === 0 && effectAttempts(follow).length === 0,
    "follow-up-citation": cited(follow),
    "initial-output": initialOutput(data, first),
  };
}

function sourceChecks(data: Record<string, unknown>, first: Turn) {
  const sources = data[prefix + "inspect-sources"];
  return {
    "inspected-citation": cited(first),
    "inspected-sources":
      isStringArray(sources) &&
      sources.every((path) => inspectedSources(first).includes(path)),
  };
}

function unavailable(test: ExtensionCase): EvaluationResult {
  return {
    checks: customNames(test).map((name) => ({
      id: prefix + name,
      status: "unavailable",
      evidenceRefs: [],
    })),
    metrics: [],
  };
}

async function response(request: ExtensionRequest): Promise<object> {
  switch (request.method) {
    case "describe":
      return {
        extension: { id: "sevro.guide", version: "3.0.0" },
        protocols: ["sevro.extension.v1"],
        requiredCapabilities: ["sevro.case.host-route"],
        optionalCapabilities: [
          "sevro.host.continuation",
          "sevro.codex.repository-invocation",
          "sevro.claude.repository-invocation",
        ],
        graders: ["sevro.guide.evidence"],
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

function evidenceRefs(
  host: Host,
  first: string,
  receipt: string,
  follow: Turn | undefined,
): string[] {
  return [first, receipt, ...(follow ? [eventId(host, true, false)] : [])];
}
