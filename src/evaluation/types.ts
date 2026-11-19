import type { PreparationSources } from "../fixtures/index";
import type { ExtensionCase, openExtensionSession } from "../extensions/index";
import type { Assessment, EvaluationProgress } from "../kernel/index";
import type { CliResultData, CliResultDataCase } from "../schema/index";
import type { TrialSummary } from "../evidence/index";
import type { RuntimePolicy } from "../runtime/index";
import type { HostAdapter, ResolvedCase } from "../host-contract/index";

export type { EvaluationProgress } from "../kernel/index";

export interface EvaluationOptions {
  /** Best-effort operational diagnostics, separate from result assessment. */
  onWarning?: (message: string) => void;
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
