import type { EvaluationOptions, EvaluationProgress } from "./types";

/** Cleanup diagnostics have no authority over assessment or persistence. */
export function evaluationWarning(
  onWarning: EvaluationOptions["onWarning"],
  message: string,
): void {
  try {
    onWarning?.(message);
  } catch {
    // A diagnostic observer must not interrupt lifecycle cleanup.
  }
}

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
