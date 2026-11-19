/**
 * Built-in check graders.
 *
 * Evaluation prepares each declared built-in check once, refusing invalid
 * configuration before any trial runs, and then grades a trial through the
 * matching entry point: output checks against the candidate's final message,
 * shell checks by running an isolated command in the candidate workspace, Git
 * HEAD checks against the recorded base revision, and semantic checks through a
 * bounded prompt whose verdicts are parsed back per proposition. Pattern
 * compilation, JSON pointer resolution, artifact containment, process
 * supervision and Git invocation stay inside.
 */
export {
  assessGitHeadCheck,
  gitHeadRevision,
  gitHeadState,
  prepareGitHeadChecks,
  type GitHeadCheckDeclaration,
  type PreparedGitHeadCheck,
} from "./git-head";
export {
  gradeOutput,
  isOutputGrader,
  prepareOutputChecks,
  type OutputCheckDeclaration,
  type PreparedOutputCheck,
} from "./output";
export { readSemanticArtifact } from "./artifact";
export {
  parseSemanticVerdicts,
  prepareSemanticChecks,
  semanticCheckGroups,
  semanticPrompt,
  type PreparedSemanticCheck,
  type SemanticCheckDeclaration,
  type SemanticVerdict,
} from "./semantic";
export {
  assessShellCheck,
  prepareShellChecks,
  runShellCheck,
  type PreparedShellCheck,
  type ShellCheckDeclaration,
} from "./shell";
