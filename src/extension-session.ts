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

async function digestSources(paths: string[]): Promise<string> {
  const hashes: string[] = [];
  for (const path of paths) {
    try {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      hashes.push(hash.digest("hex"));
    } catch {
      throw new ExtensionProtocolError(
        "declared extension source is unreadable",
      );
    }
  }
  return hashJson(hashes);
}

function jsonCopy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

/** Bind a stateless extension command to a negotiated identity and source snapshot. */
export async function openExtensionSession(options: ExtensionSessionOptions) {
  const command = [...options.command];
  const sourceFiles = [...options.sourceFiles];
  const sourceClosure = [...new Set([command[0], ...sourceFiles])];
  const taskVerdictPolicy = options.taskVerdictPolicy;
  const replacedBuiltinGraders = [
    ...(options.replaceBuiltinGraders ?? []),
  ].sort();
  const exchangeOptions: ExchangeOptions = {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  };
  if (
    !command.length ||
    !isAbsolute(command[0] ?? "") ||
    !sourceFiles.length ||
    sourceFiles.some((path) => !isAbsolute(path)) ||
    new Set(sourceFiles).size !== sourceFiles.length
  )
    throw new ExtensionProtocolError(
      "extension source files must be unique absolute paths",
    );
  if (new Set(replacedBuiltinGraders).size !== replacedBuiltinGraders.length)
    throw new ExtensionProtocolError("duplicate built-in grader replacement");
  const configuration = jsonCopy(options.configuration);
  const redactedConfiguration = jsonCopy(options.redactedConfiguration);
  const sourceDigest = await digestSources(sourceClosure);
  const negotiated = await negotiateExtension(
    command,
    {
      engineCapabilities: options.engineCapabilities,
      hostCapabilities: options.hostCapabilities,
    },
    exchangeOptions,
  );
  if ((await digestSources(sourceClosure)) !== sourceDigest)
    throw new ExtensionProtocolError(
      "extension source changed during discovery",
    );
  if (
    taskVerdictPolicy &&
    !negotiated.taskVerdictPolicies.includes(taskVerdictPolicy)
  )
    throw new ExtensionProtocolError(
      "extension did not advertise the selected task policy",
    );
  const identity: ExtensionIdentity = {
    ...negotiated,
    sourceDigest,
    configurationDigest: hashJson({
      command,
      configuration: redactedConfiguration,
      taskVerdictPolicy: taskVerdictPolicy ?? null,
      replacedBuiltinGraders,
    }),
    selectedTaskVerdictPolicy: taskVerdictPolicy ?? null,
    replacedBuiltinGraders,
  };
  Object.freeze(identity.capabilities);
  Object.freeze(identity.graders);
  Object.freeze(identity.taskVerdictPolicies);
  Object.freeze(identity.replacedBuiltinGraders);
  Object.freeze(identity);

  async function call(
    method: "resolve" | "prepare" | "evaluate",
    params: object,
  ) {
    if ((await digestSources(sourceClosure)) !== sourceDigest)
      throw new ExtensionProtocolError("extension source changed during run");
    const response = await exchangeExtension(
      command,
      {
        protocol: PROTOCOL,
        id: randomUUID(),
        method,
        params: { ...params, configuration },
      },
      exchangeOptions,
    );
    if ((await digestSources(sourceClosure)) !== sourceDigest)
      throw new ExtensionProtocolError("extension source changed during run");
    return response.result!;
  }

  return {
    identity,
    async resolve(
      projectRoot: string,
      selectors: Record<string, unknown>,
    ): Promise<ExtensionCase[]> {
      const result = await call("resolve", { projectRoot, selectors });
      const cases = result.cases as ExtensionCase[];
      const ids = cases.map((item) => item.id);
      if (new Set(ids).size !== ids.length)
        throw new ExtensionProtocolError(
          "extension resolved duplicate case IDs",
        );
      return cases;
    },
    async prepare(
      resolvedCase: ExtensionCase,
      host: { id: string; capabilities: string[] },
      condition: "passive" | "enforced",
    ): Promise<PreparationResult> {
      return (await call("prepare", {
        case: resolvedCase,
        host,
        condition,
      })) as unknown as PreparationResult;
    },
    async evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
      const result = (await call("evaluate", {
        ...request,
        ...(taskVerdictPolicy
          ? { selectedTaskVerdictPolicy: taskVerdictPolicy }
          : {}),
      })) as unknown as EvaluationResult;
      const outcomes = result.domainOutcomes ?? [];
      const ids = [
        ...result.checks.map((check) => check.id),
        ...outcomes.map((outcome) => outcome.id),
      ];
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !id.startsWith(`${identity.id}.`))
      )
        throw new ExtensionProtocolError(
          "extension returned duplicate or foreign result IDs",
        );
      if (result.taskVerdictRecommendation && !taskVerdictPolicy)
        throw new ExtensionProtocolError(
          "extension task policy was not selected",
        );
      if (taskVerdictPolicy && !result.taskVerdictRecommendation)
        throw new ExtensionProtocolError(
          "extension omitted the selected task policy recommendation",
        );
      const available = new Map(
        request.observations.map((item) => [item.id, item.completeness]),
      );
      for (const item of request.artifacts) available.set(item.id, "complete");
      for (const item of request.builtinChecks)
        available.set(
          item.id,
          item.status === "unavailable" ? "unavailable" : "complete",
        );
      for (const item of [...result.checks, ...outcomes]) {
        if (item.status === "passed" && item.evidenceRefs.length === 0)
          throw new ExtensionProtocolError(
            "extension passed a result without evidence",
          );
        if (item.evidenceRefs.some((id) => !available.has(id)))
          throw new ExtensionProtocolError(
            "extension result cites unknown evidence",
          );
        if (
          item.status === "passed" &&
          item.evidenceRefs.some((id) => available.get(id) !== "complete")
        )
          throw new ExtensionProtocolError(
            "extension passed a result with incomplete evidence",
          );
      }
      return result;
    },
  };
}
