import {
  isRecord,
  isStringArray,
  isUnknownArray,
} from "../../src/value-guards";
import { oracles } from "./answers";
import type { GuideCase } from "./types";

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid guide evidence record");
  return value;
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Invalid guide cases");
  return value;
}

function optionalChecks(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!isStringArray(value)) throw new Error("Invalid guide cases");
  return value;
}

function caseChecks(value: unknown): string[] {
  if (!isStringArray(value)) throw new Error("Invalid guide cases");
  if (value.some((check) => !oracles[check]))
    throw new Error("Invalid guide cases");
  return value;
}

function caseIdentity(value: Record<string, unknown>) {
  const texts = caseTexts(value);
  if (typeof value.activation !== "boolean")
    throw new Error("Invalid guide cases");
  if (!texts.id || !texts.prompt) throw new Error("Invalid guide cases");
  return { ...texts, activation: value.activation };
}
function caseTexts(value: Record<string, unknown>) {
  if (typeof value.id !== "string" || typeof value.prompt !== "string")
    throw new Error("Invalid guide cases");
  return { id: value.id, prompt: value.prompt };
}

function guideCase(value: unknown): GuideCase {
  const item = record(value);
  return {
    ...caseIdentity(item),
    checks: caseChecks(item.checks),
    fixture: optionalText(item.fixture),
    followUp: optionalText(item.followUp),
    followUpChecks: optionalChecks(item.followUpChecks),
  };
}

export function parseGuideCases(text: string): GuideCase[] {
  const value: unknown = JSON.parse(text);
  if (!isUnknownArray(value)) throw new Error("Invalid guide cases");
  return value.map(guideCase);
}
