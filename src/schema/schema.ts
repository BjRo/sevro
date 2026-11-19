import type {
  CliResultData,
  RunEvidenceData,
  ReportData,
} from "./schema-types";
import cliValidator from "../generated/cli-result.cjs";
import runValidator from "../generated/run-evidence.cjs";
import reportValidator from "../generated/report.cjs";
import extensionValidator from "../generated/extension.cjs";
import runtimeValidator from "../generated/runtime.cjs";
import type { ErrorObject } from "ajv";

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

/** A schema violation located by its JSON pointer into the checked value. */
export interface SchemaIssue {
  readonly pointer: string;
  readonly message: string;
}

/** First runtime configuration schema violation, or null when it conforms. */
export function runtimeConfigurationIssue(value: unknown): SchemaIssue | null {
  if (runtimeValidator(value)) return null;
  // Ajv always populates errors when validation fails.
  const issue = (runtimeValidator.errors as [ErrorObject, ...ErrorObject[]])[0];
  return { pointer: issuePointer(issue), message: String(issue.message) };
}

function issuePointer(issue: ErrorObject): string {
  const params = issue.params as Record<string, unknown>;
  const property = params.additionalProperty ?? params.missingProperty;
  const suffix =
    typeof property === "string"
      ? "/" + property.replaceAll("~", "~0").replaceAll("/", "~1")
      : "";
  return issue.instancePath + suffix || "/";
}
