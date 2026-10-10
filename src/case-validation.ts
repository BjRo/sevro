import { type ResolvedCase } from "./engine";
import { prepareGeneratedFixture } from "./generated-fixture";
import { prepareRepositoryFixture } from "./repository-fixture";
import {
  isOptionalNonblankString,
  isRecord,
  isStringArray,
} from "./value-guards";

function validGeneratedFixture(value: Record<string, unknown>): boolean {
  try {
    prepareGeneratedFixture(value);
    return true;
  } catch {
    return false;
  }
}

function validRepositoryFixture(value: Record<string, unknown>): boolean {
  try {
    prepareRepositoryFixture({ kind: "repository", ...value });
    return true;
  } catch {
    return false;
  }
}

export function validInlineFixture(value: Record<string, unknown>): boolean {
  return (
    !Object.hasOwn(value, "sourceRef") &&
    Object.hasOwn(value, "files") &&
    isRecord(value.files) &&
    Object.values(value.files).every((content) => typeof content === "string")
  );
}

function fixtureFields(value: Record<string, unknown>): boolean {
  if (Object.hasOwn(value, "sourceRef")) return validRepositoryFixture(value);
  return validInlineFixture(value);
}

function validFixture(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "generated") return validGeneratedFixture(value);
  if (value.kind !== undefined) return false;
  return fixtureFields(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validCaseDetails(value: Record<string, unknown>): boolean {
  return (
    nonemptyString(value.id) &&
    nonemptyString(value.prompt) &&
    isOptionalNonblankString(value.followUpPrompt) &&
    validFixture(value.fixture)
  );
}

function validCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.grader === "string" &&
    isRecord(value.configuration)
  );
}

function validChecks(value: unknown): boolean {
  return Array.isArray(value) && value.every(validCheck);
}

export function isResolvedCase(value: unknown): value is ResolvedCase {
  return (
    isRecord(value) &&
    validCaseDetails(value) &&
    validChecks(value.checks) &&
    isStringArray(value.requiredEvidence)
  );
}
