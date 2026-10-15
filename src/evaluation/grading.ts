import {
  assessGitHeadCheck,
  gitHeadState,
  type PreparedGitHeadCheck,
} from "../graders/git-head";
import { gradeOutput, type PreparedOutputCheck } from "../graders/output";
import {
  assessShellCheck,
  runShellCheck,
  type PreparedShellCheck,
} from "../graders/shell";
import { evaluationProtectedRoots } from "../hosts/isolation-roots";
import { sha256 } from "../identity";
import type { TrialObservation } from "../evidence/trial-writer";
import {
  ExtensionSourceChangedError,
  type EvaluationRequest,
  type EvaluationResult,
} from "../extension-session";
import type { CheckOutcome } from "../results";

export interface GradingFailure {
  readonly message: string;
  readonly cancelable: boolean;
}

export interface GradingResult {
  checks: CheckOutcome[];
  observations: TrialObservation[];
  failure: GradingFailure | null;
}

export interface GradingFailureEffects {
  /** Close admission when failure is detected, before an async result returns. */
  onFailure(failure: GradingFailure): void;
}

function failedGrading(
  checks: CheckOutcome[],
  observations: TrialObservation[],
  message: string,
  effects: GradingFailureEffects,
): GradingResult {
  const failure = { message, cancelable: true };
  effects.onFailure(failure);
  return { checks, observations, failure };
}

export function gradeCandidateOutput(input: {
  readonly result: { finalMessage: string | null; complete: boolean } | null;
  readonly checks: readonly PreparedOutputCheck[];
  readonly evidenceRefs: string[];
}): GradingResult {
  try {
    if (!input.result) throw new Error("host result is unavailable");
    const checks = gradeOutput(
      input.result.finalMessage,
      input.result.complete,
      [...input.checks],
    ).map((check) => ({ ...check, evidenceRefs: [...input.evidenceRefs] }));
    return { checks, observations: [], failure: null };
  } catch {
    return {
      checks: [],
      observations: [],
      failure: {
        message: "output grading did not complete",
        cancelable: false,
      },
    };
  }
}

interface ShellGradingInput {
  readonly checks: readonly PreparedShellCheck[];
  readonly protectedRoots:
    Parameters<typeof evaluationProtectedRoots>[0] | null;
  readonly execution: Omit<
    Parameters<typeof runShellCheck>[1],
    "protectedRoots"
  >;
}

async function gradeShellCheck(
  check: PreparedShellCheck,
  execution: Parameters<typeof runShellCheck>[1],
): Promise<{ check: CheckOutcome; observation: TrialObservation }> {
  const result = await runShellCheck(check, execution);
  const graded = assessShellCheck(check, result);
  const id = `sevro.observation.shell.${check.id}`;
  return {
    observation: {
      id,
      source: "sevro.shell",
      completeness: "complete",
      data: {
        exitCode: result.exitCode,
        expectedExitCode: check.expectedExitCode,
        ...(result.stdout === null
          ? {}
          : {
              stdoutSha256: sha256(result.stdout),
              stdoutByteLength: Buffer.byteLength(result.stdout, "utf8"),
            }),
      },
    },
    check: {
      id: check.id,
      grader: "sevro.shell",
      status: graded.passed ? "passed" : "failed",
      detail: graded.detail,
      evidenceRefs: [id],
    },
  };
}

export async function gradeShellChecks(
  input: ShellGradingInput,
  effects: GradingFailureEffects,
): Promise<GradingResult> {
  const checks: CheckOutcome[] = [];
  const observations: TrialObservation[] = [];
  try {
    if (!input.protectedRoots)
      throw new Error("shell checks require explicit protected source roots");
    const protectedRoots = await evaluationProtectedRoots(input.protectedRoots);
    for (const check of input.checks) {
      const graded = await gradeShellCheck(check, {
        ...input.execution,
        protectedRoots,
        protectedRootsCanonical: true,
      });
      checks.push(graded.check);
      observations.push(graded.observation);
    }
    return { checks, observations, failure: null };
  } catch {
    return failedGrading(
      checks,
      observations,
      "shell grading did not complete",
      effects,
    );
  }
}

export async function gradeGitHeadChecks(
  input: {
    readonly checks: readonly PreparedGitHeadCheck[];
    readonly base: string | null;
    readonly workspace: string;
    readonly signal?: AbortSignal;
  },
  effects: GradingFailureEffects,
): Promise<GradingResult> {
  const observations: TrialObservation[] = [];
  try {
    const base = input.base;
    if (base === null) throw new Error("Git HEAD base revision is unavailable");
    const state = await gitHeadState(input.workspace, base, input.signal);
    const id = "sevro.observation.git-head";
    observations.push({
      id,
      source: "sevro.git-head",
      completeness: "complete",
      data: {
        baseRevision: base,
        currentRevision: state.currentRevision,
        baseAncestor: state.baseAncestor,
      },
    });
    const checks = input.checks.map((check): CheckOutcome => {
      const graded = assessGitHeadCheck(check, base, state);
      return {
        id: check.id,
        grader: "sevro.git-head",
        status: graded.passed ? "passed" : "failed",
        detail: graded.detail,
        evidenceRefs: [id],
      };
    });
    return { checks, observations, failure: null };
  } catch {
    return failedGrading(
      [],
      observations,
      "Git HEAD grading did not complete",
      effects,
    );
  }
}

function extensionCheckResult(
  check: EvaluationResult["checks"][number],
  declared: ReadonlyMap<string, string>,
): CheckOutcome {
  const grader = declared.get(check.id);
  if (grader === undefined)
    throw new Error("extension returned an undeclared check");
  return {
    id: check.id,
    grader,
    status: check.status,
    ...(check.detail ? { detail: check.detail } : {}),
    evidenceRefs: check.evidenceRefs,
  };
}

export interface ExtensionGradingResult {
  checks: CheckOutcome[];
  metrics: EvaluationResult["metrics"];
  domainOutcomes: NonNullable<EvaluationResult["domainOutcomes"]>;
  recommendation: "passed" | "failed" | "not_assessed" | null;
  failure: GradingFailure | null;
}

export async function gradeExtensionChecks(
  input: {
    readonly evaluate: (
      request: EvaluationRequest,
    ) => Promise<EvaluationResult>;
    readonly request: EvaluationRequest;
    readonly declarations: readonly { id: string; grader: string }[];
  },
  effects: GradingFailureEffects,
): Promise<ExtensionGradingResult> {
  try {
    const result = await input.evaluate(input.request);
    const declared = new Map(
      input.declarations.map((check) => [check.id, check.grader]),
    );
    return {
      checks: result.checks.map((check) =>
        extensionCheckResult(check, declared),
      ),
      metrics: result.metrics,
      domainOutcomes: result.domainOutcomes ?? [],
      recommendation: result.taskVerdictRecommendation ?? null,
      failure: null,
    };
  } catch (error) {
    const failure = {
      message:
        error instanceof ExtensionSourceChangedError
          ? "extension source inputs changed during evaluation; assessment was refused. Finish changing evaluator inputs, then start a fresh evaluation with inputs held stable."
          : "extension grading did not complete",
      cancelable: true,
    };
    effects.onFailure(failure);
    return {
      checks: [],
      metrics: [],
      domainOutcomes: [],
      recommendation: null,
      failure,
    };
  }
}
