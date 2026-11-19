import type {
  InstrumentationCapability,
  InstrumentationRequest,
} from "../instrumentation";
import type { GeneratedFixture } from "../fixtures/generated";
import type { RepositoryFixture } from "../fixtures/repository";
import type { CheckDeclaration, ObservationEvidence } from "../contract-types";
import type { RuntimePolicy, RuntimeRole } from "../runtime/index";
import type { CandidateArtifactRoots } from "../candidate-artifacts";

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
  /** Adapter-owned, bounded failure summary suitable for CLI diagnostics. */
  failureMessage?: string;
  processFailure?: {
    phase: "isolation-preflight" | "executable-preflight" | "execution";
    reason: "exit" | "timeout" | "cancelled";
    timeoutMs: number;
  };
  artifacts?: { id: string; bytes: Uint8Array }[];
  observations?: Omit<ObservationEvidence, "source">[];
  actualCondition?: "passive" | "enforced" | "unknown";
  appliedInstrumentation?: InstrumentationRequest[];
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  usageComplete?: boolean;
}

/** A failed host call can still provide bounded evidence for retention. */
export class HostExecutionFailure extends Error {
  readonly result: HostResult;
  constructor(
    message: string | undefined,
    result: HostResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.result = { ...result, executionFailed: true, failureMessage: message };
  }
}

export interface HostAdapter {
  id: string;
  model: string;
  effort: string;
  instrumentation?: InstrumentationCapability[];
  hostCapabilities?: string[];
  configuration?: Record<string, unknown>;
  run(request: {
    /** Persist private diagnostic bytes before the native host removes its state. */
    retainHostDiagnostics?: (bytes: Uint8Array) => Promise<void>;
    runtimePolicy?: RuntimePolicy;
    runtimeRole?: RuntimeRole;
    candidateTranscriptRoot?: string;
    candidateRuntimeRoot?: string;
    candidateArtifactRoots?: CandidateArtifactRoots;
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
  checks: CheckDeclaration[];
  requiredEvidence: string[];
}
