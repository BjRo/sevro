import validExchange from "./generated/extension.cjs";
import { isRecord } from "./value-guards";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalJson, hashJson } from "./identity";
import type { GeneratedFixture } from "./generated-fixture";
import type { RepositoryFixture } from "./repository-fixture";
import type { FixtureSetupDeclaration } from "./fixture-setup";
import {
  ExtensionProtocolError,
  exchangeExtension,
  negotiateExtension,
  type ExchangeOptions,
  type NegotiatedExtension,
} from "./extension-client";

const PROTOCOL = "sevro.extension.v1";

export interface ExtensionCase {
  id: string;
  prompt: string;
  followUpPrompt?: string;
  fixture:
    | { kind: "inline"; files: Record<string, string> }
    | RepositoryFixture
    | GeneratedFixture;
  checks: {
    id: string;
    grader: string;
    configuration: Record<string, unknown>;
  }[];
  requiredEvidence: string[];
  extensionData: Record<string, unknown>;
}

export interface PreparationResult {
  artifacts: {
    id: string;
    relativePath: string;
    sha256: string;
    contentBase64?: string;
    sourceRef?: string;
    gitExclude?: boolean;
    executable?: boolean;
  }[];
  requestedInstrumentation: {
    id: string;
    configuration: Record<string, unknown>;
  }[];
  fixtureSetup?: FixtureSetupDeclaration;
  codexMarketplace?: {
    artifactRoot: string;
    marketplaceName: string;
    pluginNames: string[];
  };
  claudePluginDirs?: { artifactRoots: string[] };
  codexSkillInvocation?: {
    pluginName: string;
    skillName: string;
  };
  codexRepositorySkillInvocation?: { skillName: string };
  claudeRepositorySkillInvocation?: { skillName: string };
  claudeSkillInvocation?: {
    pluginName: string;
    skillName: string;
  };
  extensionData: Record<string, unknown>;
}

export interface EvaluationRequest {
  caseId: string;
  execution: {
    status: "completed" | "failed" | "cancelled" | "not_run";
    errorCode?: string;
  };
  observations: {
    id: string;
    source: string;
    completeness: "complete" | "partial" | "unavailable";
    data: Record<string, unknown>;
  }[];
  builtinChecks: {
    id: string;
    status: "passed" | "failed" | "unavailable";
    detail?: string;
    evidenceRefs: string[];
  }[];
  artifacts: {
    id: string;
    path: string;
    sha256: string;
    gitExclude?: boolean;
    executable?: boolean;
  }[];
  extensionData: Record<string, unknown>;
}

export interface EvaluationResult {
  checks: {
    id: string;
    status: "passed" | "failed" | "unavailable";
    detail?: string;
    evidenceRefs: string[];
  }[];
  metrics: { id: string; value: number | null; unit: string }[];
  domainOutcomes?: {
    id: string;
    status: "passed" | "failed" | "unavailable";
    detail?: string;
    evidenceRefs: string[];
    data?: Record<string, unknown>;
  }[];
  taskVerdictRecommendation?: "passed" | "failed" | "not_assessed";
}

export interface ExtensionSessionOptions extends ExchangeOptions {
  command: string[];
  sourceFiles: string[];
  configuration: Record<string, unknown>;
  redactedConfiguration: Record<string, unknown>;
  engineCapabilities: string[];
  hostCapabilities: string[];
  taskVerdictPolicy?: string;
  replaceBuiltinGraders?: string[];
}

export interface ExtensionIdentity extends NegotiatedExtension {
  sourceDigest: string;
  configurationDigest: string;
  selectedTaskVerdictPolicy: string | null;
  replacedBuiltinGraders: string[];
}

async function digestSource(path: string): Promise<string> {
  try {
    const hash = createHash("sha256");
    for await (const value of createReadStream(path)) {
      const chunk: unknown = value;
      if (!(chunk instanceof Uint8Array))
        throw new Error("invalid extension source stream");
      hash.update(chunk);
    }
    return hash.digest("hex");
  } catch (cause) {
    throw new ExtensionProtocolError(
      "declared extension source is unreadable",
      { cause },
    );
  }
}

async function digestSources(paths: string[]): Promise<string> {
  const hashes: string[] = [];
  for (const path of paths) hashes.push(await digestSource(path));
  return hashJson(hashes);
}

function jsonCopy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function absoluteSessionCommand(
  command: string[],
): command is [string, ...string[]] {
  const executable = command[0];
  return executable !== undefined && isAbsolute(executable);
}

function uniqueAbsoluteSources(sources: string[]): boolean {
  return (
    sources.length > 0 &&
    sources.every((path) => isAbsolute(path)) &&
    new Set(sources).size === sources.length
  );
}

function sessionSourceClosure(command: string[], sources: string[]): string[] {
  if (!absoluteSessionCommand(command) || !uniqueAbsoluteSources(sources))
    throw new ExtensionProtocolError(
      "extension source files must be unique absolute paths",
    );
  return [...new Set([command[0], ...sources])];
}

function validateGraderReplacements(graders: string[]): void {
  if (new Set(graders).size !== graders.length)
    throw new ExtensionProtocolError("duplicate built-in grader replacement");
}

function sessionConfiguration(options: ExtensionSessionOptions) {
  const command = [...options.command];
  const sourceFiles = [...options.sourceFiles];
  const taskVerdictPolicy = options.taskVerdictPolicy;
  const replacedBuiltinGraders = [
    ...(options.replaceBuiltinGraders ?? []),
  ].sort();
  const exchangeOptions: ExchangeOptions = {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  };
  const sourceClosure = sessionSourceClosure(command, sourceFiles);
  validateGraderReplacements(replacedBuiltinGraders);
  const configuration = jsonCopy(options.configuration);
  const redactedConfiguration = jsonCopy(options.redactedConfiguration);
  return {
    command,
    sourceFiles,
    taskVerdictPolicy,
    replacedBuiltinGraders,
    exchangeOptions,
    sourceClosure,
    configuration,
    redactedConfiguration,
  };
}

type SessionConfiguration = ReturnType<typeof sessionConfiguration>;

function sessionIdentity(
  context: SessionConfiguration,
  negotiated: NegotiatedExtension,
  sourceDigest: string,
): ExtensionIdentity {
  const identity: ExtensionIdentity = {
    ...negotiated,
    sourceDigest,
    configurationDigest: hashJson({
      command: context.command,
      configuration: context.redactedConfiguration,
      taskVerdictPolicy: context.taskVerdictPolicy ?? null,
      replacedBuiltinGraders: context.replacedBuiltinGraders,
    }),
    selectedTaskVerdictPolicy: context.taskVerdictPolicy ?? null,
    replacedBuiltinGraders: context.replacedBuiltinGraders,
  };
  Object.freeze(identity.capabilities);
  Object.freeze(identity.graders);
  Object.freeze(identity.taskVerdictPolicies);
  Object.freeze(identity.replacedBuiltinGraders);
  Object.freeze(identity);
  return identity;
}

async function discoverSession(
  configuration: SessionConfiguration,
  options: ExtensionSessionOptions,
) {
  const sourceDigest = await digestSources(configuration.sourceClosure);
  const negotiated = await negotiateExtension(
    configuration.command,
    {
      engineCapabilities: options.engineCapabilities,
      hostCapabilities: options.hostCapabilities,
    },
    configuration.exchangeOptions,
  );
  if ((await digestSources(configuration.sourceClosure)) !== sourceDigest)
    throw new ExtensionProtocolError(
      "extension source changed during discovery",
    );
  if (
    configuration.taskVerdictPolicy &&
    !negotiated.taskVerdictPolicies.includes(configuration.taskVerdictPolicy)
  )
    throw new ExtensionProtocolError(
      "extension did not advertise the selected task policy",
    );
  return {
    ...configuration,
    sourceDigest,
    identity: sessionIdentity(configuration, negotiated, sourceDigest),
  };
}

type SessionContext = Awaited<ReturnType<typeof discoverSession>>;
interface SessionResults {
  resolve: { cases: ExtensionCase[] };
  prepare: PreparationResult;
  evaluate: EvaluationResult;
}

function sessionResponse<M extends keyof SessionResults>(
  value: unknown,
  method: M,
): value is { method: M; result: SessionResults[M] } {
  return (
    validExchange(value) &&
    isRecord(value) &&
    value.method === method &&
    Object.hasOwn(value, "result")
  );
}

async function verifySessionSources(context: SessionContext): Promise<void> {
  if ((await digestSources(context.sourceClosure)) !== context.sourceDigest)
    throw new ExtensionProtocolError("extension source changed during run");
}

async function callSession<M extends keyof SessionResults>(
  context: SessionContext,
  method: M,
  params: object,
): Promise<SessionResults[M]> {
  await verifySessionSources(context);
  const response = await exchangeExtension(
    context.command,
    {
      protocol: PROTOCOL,
      id: randomUUID(),
      method,
      params: { ...params, configuration: context.configuration },
    },
    context.exchangeOptions,
  );
  await verifySessionSources(context);
  if (!sessionResponse(response, method))
    throw new ExtensionProtocolError("invalid extension response");
  return response.result;
}

interface ResolvedHostRoute {
  id: string;
  model: string;
  effort: string;
  capabilities: string[];
}

async function resolveSession(
  context: SessionContext,
  projectRoot: string,
  selectors: Record<string, unknown>,
  host: ResolvedHostRoute | undefined,
): Promise<ExtensionCase[]> {
  const result = await callSession(context, "resolve", {
    projectRoot,
    selectors,
    ...(host ? { host } : {}),
  });
  const ids = result.cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length)
    throw new ExtensionProtocolError("extension resolved duplicate case IDs");
  return result.cases;
}

async function prepareSession(
  context: SessionContext,
  resolvedCase: ExtensionCase,
  host: { id: string; capabilities: string[] },
  condition: "passive" | "enforced",
): Promise<PreparationResult> {
  return callSession(context, "prepare", {
    case: resolvedCase,
    host,
    condition,
  });
}

function validateEvaluationIds(
  result: EvaluationResult,
  outcomes: NonNullable<EvaluationResult["domainOutcomes"]>,
  extensionId: string,
): void {
  const ids = [
    ...result.checks.map((check) => check.id),
    ...outcomes.map((outcome) => outcome.id),
  ];
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !id.startsWith(`${extensionId}.`))
  )
    throw new ExtensionProtocolError(
      "extension returned duplicate or foreign result IDs",
    );
}

function validateSelectedTaskPolicy(
  result: EvaluationResult,
  policy: string | undefined,
): void {
  if (result.taskVerdictRecommendation && !policy)
    throw new ExtensionProtocolError("extension task policy was not selected");
  if (policy && !result.taskVerdictRecommendation)
    throw new ExtensionProtocolError(
      "extension omitted the selected task policy recommendation",
    );
}

function availableEvidence(request: EvaluationRequest): Map<string, string> {
  const available = new Map<string, string>(
    request.observations.map((item) => [item.id, item.completeness]),
  );
  for (const item of request.artifacts) available.set(item.id, "complete");
  for (const item of request.builtinChecks)
    available.set(
      item.id,
      item.status === "unavailable" ? "unavailable" : "complete",
    );
  return available;
}

type EvidenceOutcome = EvaluationResult["checks"][number];
function passedWithoutEvidence(item: EvidenceOutcome): boolean {
  return item.status === "passed" && item.evidenceRefs.length === 0;
}
function passedWithIncompleteEvidence(
  item: EvidenceOutcome,
  available: Map<string, string>,
): boolean {
  return (
    item.status === "passed" &&
    item.evidenceRefs.some((id) => available.get(id) !== "complete")
  );
}

function validateResultEvidence(
  item: EvidenceOutcome,
  available: Map<string, string>,
): void {
  if (passedWithoutEvidence(item))
    throw new ExtensionProtocolError(
      "extension passed a result without evidence",
    );
  if (item.evidenceRefs.some((id) => !available.has(id)))
    throw new ExtensionProtocolError("extension result cites unknown evidence");
  if (passedWithIncompleteEvidence(item, available))
    throw new ExtensionProtocolError(
      "extension passed a result with incomplete evidence",
    );
}

async function evaluateSession(
  context: SessionContext,
  request: EvaluationRequest,
): Promise<EvaluationResult> {
  const result = await callSession(context, "evaluate", {
    ...request,
    ...(context.taskVerdictPolicy
      ? { selectedTaskVerdictPolicy: context.taskVerdictPolicy }
      : {}),
  });
  const outcomes = result.domainOutcomes ?? [];
  validateEvaluationIds(result, outcomes, context.identity.id);
  validateSelectedTaskPolicy(result, context.taskVerdictPolicy);
  const available = availableEvidence(request);
  for (const item of [...result.checks, ...outcomes])
    validateResultEvidence(item, available);
  return result;
}

function extensionSession(context: SessionContext) {
  return {
    identity: context.identity,
    get redactedConfiguration() {
      return jsonCopy(context.redactedConfiguration);
    },
    resolve(
      projectRoot: string,
      selectors: Record<string, unknown>,
      host?: ResolvedHostRoute,
    ): Promise<ExtensionCase[]> {
      return resolveSession(context, projectRoot, selectors, host);
    },
    prepare(
      resolvedCase: ExtensionCase,
      host: { id: string; capabilities: string[] },
      condition: "passive" | "enforced",
    ): Promise<PreparationResult> {
      return prepareSession(context, resolvedCase, host, condition);
    },
    evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
      return evaluateSession(context, request);
    },
  };
}

/** Bind a stateless extension command to a negotiated identity and source snapshot. */
export async function openExtensionSession(options: ExtensionSessionOptions) {
  return extensionSession(
    await discoverSession(sessionConfiguration(options), options),
  );
}
