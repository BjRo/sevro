import {
  HostProcessFailure,
  runHostProcess,
  type HostProcessOptions,
  type HostProcessResult,
  type Phase,
} from "./process-lifecycle";

export class CodexProcessFailure extends HostProcessFailure {
  constructor(phase: Phase, result: HostProcessResult) {
    super("Codex", phase, result);
  }
}

export function runCodexProcess(options: Omit<HostProcessOptions, "host">) {
  return runHostProcess({ ...options, host: "Codex" });
}
