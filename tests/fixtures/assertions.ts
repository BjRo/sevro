import {
  assertCliResult,
  assertReport,
  assertRunEvidence,
} from "../../src/schema";
import type { CliResultData, RunEvidenceData } from "../../src/schema-types";
import type { ResolvedCase } from "../../src/engine";
import { expect } from "bun:test";

/** Fail at the point a test assumes a required value is present. */
export function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Expected a defined test value");
  return value;
}

export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a JSON string");
  return value;
}

export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Expected a finite JSON number");
  return value;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a JSON array");
  return value as unknown[];
}

export function parseRecord(text: string) {
  return record(parseJson(text));
}

export function parseCliResult(text: string) {
  const value = parseJson(text);
  assertCliResult(value);
  return value;
}

export function parseRunEvidence(text: string) {
  const value = parseJson(text);
  assertRunEvidence(value);
  return value;
}

export function parseReport(text: string) {
  const value = parseJson(text);
  assertReport(value);
  return value;
}

export function parseCheckpoint(text: string) {
  const value = parseRecord(text);
  const completedTrials = array(value.completedTrials).map((entry) => {
    const trial = record(entry);
    return {
      trial: number(trial.trial),
      artifactPath: string(trial.artifactPath),
    };
  });
  return {
    ...value,
    format: string(value.format),
    status: value.status === undefined ? undefined : string(value.status),
    checkpointPath:
      value.checkpointPath === undefined
        ? undefined
        : string(value.checkpointPath),
    artifactPath:
      value.artifactPath === undefined ? undefined : string(value.artifactPath),
    completedTrials,
  };
}

function trialResult(value: unknown) {
  const wrapper: unknown = {
    format: "sevro.cli-result.v1",
    runId: null,
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "passed" },
    exitCode: 0,
    evidencePath: null,
    cases: [
      {
        caseId: "test",
        execution: { status: "completed" },
        grading: { status: "completed" },
        task: { verdict: "passed" },
        trials: [value],
      },
    ],
  };
  assertCliResult(wrapper);
  return defined(defined(wrapper.cases[0]).trials[0]);
}

export function parseTrial(text: string) {
  const value = parseRecord(text);
  const evidence = record(value.evidence);
  const routes = array(evidence.routes).map((entry) => {
    const route = record(entry);
    return { ...route, host: string(route.host), model: string(route.model) };
  });
  return {
    ...value,
    result: trialResult(value.result),
    evidence: { ...evidence, routes },
  };
}

export function parseOwner(text: string) {
  const value = parseRecord(text);
  const owner = record(value.owner);
  return { ...value, status: string(value.status), owner };
}

export function checkoutRunner(value: RunEvidenceData["runner"]) {
  if (value.source !== "checkout")
    throw new Error("Expected checkout runner evidence");
  return value;
}

export function parallelSample(value: unknown) {
  const data = record(value);
  return {
    ...data,
    peak: number(data.peak),
    workspace: string(data.workspace),
    original: string(data.original),
  };
}

/** Bun's asymmetric matcher declarations return any; keep that boundary unknown. */
export function objectContaining(value: object): unknown {
  const matcher: unknown = expect.objectContaining(value);
  return matcher;
}

export function arrayContaining(value: unknown[]): unknown {
  const matcher: unknown = expect.arrayContaining(value);
  return matcher;
}

/** Compare validated JSON and asymmetric matchers without claiming they share a TS type. */
export function expectUnknown(actual: unknown, message?: string) {
  return expect(actual, message);
}

export function parseRelease(text: string) {
  const value = parseRecord(text);
  const runtimes = record(value.runtimes);
  return {
    ...value,
    sha256: string(value.sha256),
    runtimes: {
      ...runtimes,
      node: string(runtimes.node),
      npm: string(runtimes.npm),
    },
    files: array(value.files).map((entry) => ({
      ...record(entry),
      path: string(record(entry).path),
    })),
  };
}

export type TrialResult = CliResultData["cases"][number]["trials"][number];

/** The controlled declaration written by the CLI fixture, before per-test edits. */
export function fixtureCase(): ResolvedCase {
  return {
    id: "answer",
    prompt: "Return ready.",
    fixture: { files: { "README.md": "fixture\n" } },
    checks: [
      {
        id: "ready",
        grader: "sevro.regex",
        configuration: { pattern: "^ready$" },
      },
    ],
    requiredEvidence: [],
  };
}
