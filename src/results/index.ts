/**
 * Results: reduction of execution, grading and task states into assessments
 * and exit codes, and the retained-results commands that report on and prune
 * saved evidence under the shared results lock.
 */
export {
  applyTaskVerdictPolicy,
  assessTrial,
  exitCodeFor,
  summarizeAssessments,
  summarizeCases,
} from "./results";
export { createReport, reportCommand } from "./report";
export { pruneCommand } from "./prune";
export { withResultsLock } from "./results-lock";
