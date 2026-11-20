import type {
  InstrumentationCapability,
  InstrumentationRequest,
  CheckDeclaration,
  ObservationEvidence,
} from "../kernel/index";
import type {
  RuntimePolicy,
  RuntimeRole,
  CandidateArtifactRoots,
} from "../runtime/index";

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

/** A fixture declared as a Git history generated from inline commits. */
export interface GeneratedFixture {
  kind: "generated";
  commits: { message: string; files: Record<string, string> }[];
  files?: Record<string, string>;
  staged?: string[];
  commitFiles?: boolean;
  hooks?: Record<string, string>;
  bin?: Record<string, string>;
}

/** A fixture cloned from a declared local repository source plus an overlay. */
export interface RepositoryFixture {
  kind: "repository";
  sourceRef: string;
  files?: Record<string, string>;
  staged?: string[];
  commitFiles?: boolean;
  hooks?: Record<string, string>;
  bin?: Record<string, string>;
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
