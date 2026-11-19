import type {
  CliResultData,
  RunEvidenceData,
  ReportData,
} from "./schema-types";
import cliValidator from "../generated/cli-result.cjs";
import runValidator from "../generated/run-evidence.cjs";
import reportValidator from "../generated/report.cjs";
import extensionValidator from "../generated/extension.cjs";

export function assertCliResult(
  value: unknown,
): asserts value is CliResultData {
  if (!cliValidator(value)) throw new Error("invalid Sevro CLI result");
}

export function assertRunEvidence(
  value: unknown,
): asserts value is RunEvidenceData {
  if (!runValidator(value)) throw new Error("invalid Sevro retained evidence");
}

export function assertReport(value: unknown): asserts value is ReportData {
  if (!reportValidator(value)) throw new Error("invalid Sevro report");
}

/** Structural check of one extension protocol request or response envelope. */
export function validExtensionExchange(value: unknown): boolean {
  return extensionValidator(value);
}
