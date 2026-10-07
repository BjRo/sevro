import cliValidator from "./generated/cli-result.cjs";
import runValidator from "./generated/run-evidence.cjs";
import reportValidator from "./generated/report.cjs";

export function assertCliResult(value: unknown): void {
  if (!cliValidator(value)) throw new Error("invalid Sevro CLI result");
}

export function assertRunEvidence(value: unknown): void {
  if (!runValidator(value)) throw new Error("invalid Sevro retained evidence");
}

export function assertReport(value: unknown): void {
  if (!reportValidator(value)) throw new Error("invalid Sevro report");
}
