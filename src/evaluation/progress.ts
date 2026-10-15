import type { EvaluationOptions, EvaluationProgress } from "./types";

/** Observation is best-effort and cannot change assessment or persistence. */
export function evaluationProgress(
  options: EvaluationOptions,
  stage: EvaluationProgress["stage"],
  status: EvaluationProgress["status"],
  trial?: number,
): void {
  try {
    options.onProgress?.({
      stage,
      status,
      ...(trial === undefined ? {} : { trial }),
    });
  } catch {
    // An observer has no authority over the evaluation lifecycle.
  }
}
