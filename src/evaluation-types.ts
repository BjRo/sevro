import type {
  InstrumentationCapability,
  InstrumentationRequest,
} from "./instrumentation";
import type { GeneratedFixture } from "./generated-fixture";
import type { PreparationSources } from "./preparation";
import type { RepositoryFixture } from "./repository-fixture";
import type { EvaluationResult, ExtensionCase } from "./extension-session";
import type { openExtensionSession } from "./extension-session";
import type { Assessment, CheckOutcome } from "./results";
import type { RuntimePolicy } from "./runtime-config";
import type { RuntimeRole } from "./runtime-state";

export class EvaluationConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationConfigurationError";
  }
}

export interface HostResult {
  finalMessage: string | null;
  complete: boolean;
  executionFailed?: boolean;
  artifacts?: { id: string; bytes: Uint8Array }[];
  observations?: {
    id: string;
    completeness: "complete" | "partial" | "unavailable";
    data: Record<string, unknown>;
  }[];
  actualCondition?: "passive" | "enforced" | "unknown";
  appliedInstrumentation?: InstrumentationRequest[];
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  usageComplete?: boolean;
}

export interface HostAdapter {
  id: string;
  model: string;
  effort: string;
  instrumentation?: InstrumentationCapability[];
  hostCapabilities?: string[];
  configuration?: Record<string, unknown>;
  run(request: {
    runtimePolicy?: RuntimePolicy;
    runtimeRole?: RuntimeRole;
    prompt: string;
    followUpPrompt?: string;
    workspace: string;
    condition: "passive" | "enforced";
    fixtureBinDir?: string;
    instrumentation?: InstrumentationRequest[];
    codexMarketplace?: {
      artifactRoot: string;
      marketplaceName: string;
      pluginNames: string[];
      artifactPaths: string[];
    };
    claudePluginDirs?: {
      artifactRoots: string[];
      artifactPaths: string[];
    };
    explicitSkillInvocation?:
      | {
          scope?: "plugin";
          pluginName: string;
          skillName: string;
          token: string;
        }
      | {
          scope: "repository";
          pluginName?: never;
          skillName: string;
          token: string;
        };
    signal?: AbortSignal;
  }): Promise<HostResult>;
}

export interface ResolvedCase {
  id: string;
  prompt: string;
  followUpPrompt?: string;
  fixture:
    | { files: Record<string, string>; sourceRef?: never }
    | Omit<RepositoryFixture, "kind">
    | (GeneratedFixture & { sourceRef?: never });
  checks: {
    id: string;
    grader: string;
    configuration: Record<string, unknown>;
  }[];
  requiredEvidence: string[];
}

export interface EvaluationOptions {
  runtimePolicy?: RuntimePolicy;
  projectRoot: string;
  resultsRoot: string;
  runStateRoot?: string;
  case: ResolvedCase;
  host: HostAdapter;
  semanticHost?: HostAdapter;
  advisoryHost?: HostAdapter;
  advisoryExcludedPaths?: string[];
  runnerBuildDigest: string;
  runnerCheckoutRoot?: string;
  projectDigest: string;
  condition: "passive" | "enforced";
  trialCount: number;
  jobs?: number;
  passThreshold: number;
  dry?: boolean;
  signal?: AbortSignal;
  extension?: {
    session: Awaited<ReturnType<typeof openExtensionSession>>;
    resolvedCase: ExtensionCase;
  };
  preparationSources?: PreparationSources;
  shellIsolation?: {
    protectedRoots: string[];
    toolchainBinDir?: string;
    uvRuntimeCache?: boolean;
  };
}

export interface TrialSummary extends Assessment {
  trial: number;
  checks: CheckOutcome[];
  domainOutcomes: NonNullable<EvaluationResult["domainOutcomes"]>;
  artifactPath: string;
}

export interface CaseSummary extends Assessment {
  caseId: string;
  trials: TrialSummary[];
}

export interface CliResult extends Assessment {
  format: "sevro.cli-result.v1";
  runId: string;
  exitCode: number;
  evidencePath: string;
  cases: CaseSummary[];
}
