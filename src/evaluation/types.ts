import type {
  InstrumentationCapability,
  InstrumentationRequest,
} from "../instrumentation";
import type { GeneratedFixture } from "../fixtures/generated";
import type { PreparationSources } from "../fixtures/preparation";
import type { RepositoryFixture } from "../fixtures/repository";
import type { ExtensionCase } from "../extension-session";
import type { openExtensionSession } from "../extension-session";
import type {
  Assessment,
  CheckDeclaration,
  DomainOutcome,
  ObservationEvidence,
} from "../contract-types";
import type {
  CliResultData,
  CliResultDataCase,
  CliResultDataTrial,
} from "../schema-types";
import type { RuntimePolicy } from "../runtime/config";
import type { RuntimeRole } from "../runtime/state";
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

export class TrialPersistenceError extends Error {
  constructor(workspace: string, options?: ErrorOptions) {
    super(
      `trial persistence failed; fixture retained at ${workspace}`,
      options,
    );
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

export interface EvaluationProgress {
  stage: "preparation" | "candidate" | "grading" | "evidence";
  status: "started" | "completed" | "skipped";
  trial?: number;
}

export interface EvaluationOptions {
  /** Optional best-effort observation; exceptions never change the evaluation. */
  onProgress?: (event: EvaluationProgress) => void;
  /** Redacted operator preview, retained for reproduction outside semantic identity. */
  resolvedRunSettings?: Record<string, unknown>;
  /** Additional non-secret assessment settings included in configuration identity. */
  assessmentSettings?: Record<string, unknown>;
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

/** Persisted evaluations always retain a trial path and a known outcome list. */
export interface TrialSummary
  extends
    Assessment,
    Omit<
      CliResultDataTrial,
      keyof Assessment | "domainOutcomes" | "artifactPath"
    > {
  domainOutcomes: DomainOutcome[];
  artifactPath: string;
}

export interface CaseSummary
  extends Assessment, Omit<CliResultDataCase, keyof Assessment | "trials"> {
  trials: TrialSummary[];
}

/** Unlike pre-run wire failures, a returned evaluation has run/evidence paths. */
export interface CliResult
  extends
    Assessment,
    Omit<
      CliResultData,
      keyof Assessment | "runId" | "exitCode" | "evidencePath" | "cases"
    > {
  runId: string;
  exitCode: number;
  evidencePath: string;
  cases: CaseSummary[];
}
