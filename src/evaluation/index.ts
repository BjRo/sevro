/**
 * Evaluation orchestration for one resolved case.
 *
 * Callers pass assembled evaluation options and receive the reduced CLI
 * result. Preparation, scheduling, trial execution, grading, advisory review
 * and result collection stay inside.
 */
export { runEvaluation } from "./run";
export type { CliResult, EvaluationOptions, EvaluationProgress } from "./types";
