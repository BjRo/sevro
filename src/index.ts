import { prepareRunInvocation } from "./cli/preparation";
import { evaluateInvocation } from "./cli/evaluation";
import type { EvaluateOptions, EvaluationResult } from "./api-types";

export type {
  EvaluateOptions,
  EvaluationResult,
  EvaluationCaseResult,
  EvaluationTrialResult,
  EvaluationProgress,
} from "./api-types";

/** Prepare and execute an evaluation without owning process output or exit state. */
export async function evaluate(
  options: EvaluateOptions,
): Promise<EvaluationResult> {
  const prepared = await prepareRunInvocation(
    [...options.argv],
    options.onWarning,
  );
  const { result } = await evaluateInvocation(
    prepared,
    options.signal ?? new AbortController().signal,
    options.onProgress,
    options.onWarning,
  );
  return result;
}
