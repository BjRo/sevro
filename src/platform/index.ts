/**
 * Platform: operating-system, process, filesystem and Git adapters with no
 * knowledge of Sevro features. It depends only on other base modules.
 */
export { spawn, spawnSync, type Subprocess } from "./runtime-process";
export {
  ProcessDeadline,
  captureBoundedBytes,
  captureBoundedText,
  terminateOwnedProcessGroup,
} from "./process-lifecycle";
export { gitArguments, gitEnvironment, runGit } from "./git";
export { insideRoot, minimalRoots } from "./paths";
export { which } from "./executable";
export { shellQuote } from "./shell";
export { openLockDatabase } from "./sqlite-lock";
export { atomicWriteJson } from "./storage";
export { copyIntoReservedDirectory } from "./reserved-directory";
export {
  examplePath,
  runnerRoot,
  runtimeModule,
  sourceRuntime,
} from "./runner-paths";
