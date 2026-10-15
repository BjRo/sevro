import { type ResolvedCase } from "./engine";
import { prepareGeneratedFixture } from "./fixtures/generated";
import { prepareRepositoryFixture } from "./fixtures/repository";
import { isOptionalNonblankString, isRecord } from "./value-guards";

function fixtureDeclarationIssue(
  value: Record<string, unknown>,
): string | undefined {
  try {
    if (value.kind === "generated") prepareGeneratedFixture(value);
    else prepareRepositoryFixture({ kind: "repository", ...value });
    return undefined;
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "invalid declaration";
    return `fixture: ${detail}; correct the fixture declaration`;
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

function inlineFixtureIssue(
  value: Record<string, unknown>,
): string | undefined {
  if (!Object.hasOwn(value, "files") || !isRecord(value.files))
    return "fixture.files: expected an object mapping file paths to string contents";
  const entry = Object.entries(value.files).find(
    ([, content]) => typeof content !== "string",
  );
  return entry
    ? `fixture.files[${JSON.stringify(entry[0])}]: expected string contents`
    : undefined;
}

function fixtureIssue(value: unknown): string | undefined {
  if (!isRecord(value)) return "fixture: expected an object";
  if (value.kind === "generated") return fixtureDeclarationIssue(value);
  if (value.kind !== undefined)
    return "fixture.kind: omit for inline/repository fixtures, or use generated";
  if (Object.hasOwn(value, "sourceRef")) return fixtureDeclarationIssue(value);
  return inlineFixtureIssue(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function caseDetailsIssue(value: Record<string, unknown>): string | undefined {
  for (const field of ["id", "prompt"])
    if (!nonemptyString(value[field]))
      return `${field}: expected a nonempty string`;
  if (!isOptionalNonblankString(value.followUpPrompt))
    return "followUpPrompt: omit or supply a nonblank string";
  return fixtureIssue(value.fixture);
}

function checkIssue(value: unknown, location: string): string | undefined {
  if (!isRecord(value)) return `${location}: expected an object`;
  for (const field of ["id", "grader"])
    if (typeof value[field] !== "string")
      return `${location}.${field}: expected a string`;
  if (!isRecord(value.configuration))
    return `${location}.configuration: expected an object`;
  return undefined;
}

function checksIssue(value: unknown): string | undefined {
  if (!Array.isArray(value))
    return "checks: expected an array of check objects";
  for (const [index, check] of value.entries()) {
    const issue = checkIssue(check, `checks[${index}]`);
    if (issue) return issue;
  }
  return undefined;
}

function requiredEvidenceIssue(value: unknown): string | undefined {
  if (!Array.isArray(value))
    return "requiredEvidence: expected an array of strings";
  const index = value.findIndex((entry: unknown) => typeof entry !== "string");
  return index < 0
    ? undefined
    : `requiredEvidence[${index}]: expected a string`;
}

/** Explain the first invalid field using the same checks as the case type guard. */
export function resolvedCaseIssue(value: unknown): string | undefined {
  if (!isRecord(value)) return "case: expected an object";
  return (
    caseDetailsIssue(value) ??
    checksIssue(value.checks) ??
    requiredEvidenceIssue(value.requiredEvidence)
  );
}

export function isResolvedCase(value: unknown): value is ResolvedCase {
  return resolvedCaseIssue(value) === undefined;
}
