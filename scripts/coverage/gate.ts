import type {
  CoverageMap,
  CoverageMapData,
  FileCoverageData,
} from "istanbul-lib-coverage";
import type { CoverageIdentity, CoverageParticipant } from "./types";
import { createCoverageMap } from "istanbul-lib-coverage";
import { object, participant, numbers, branches } from "./records";

export function thresholdFailure(map: CoverageMap) {
  const summary = map.getCoverageSummary().toJSON();
  const failed = (["statements", "branches"] as const).filter(
    (metric) => summary[metric].covered * 100 < summary[metric].total * 95,
  );
  if (failed.length) throw new Error(`Below 95%: ${failed.join(", ")}`);
  return summary;
}

function fileCoverage(value: unknown, expected: FileCoverageData) {
  const entry = object(value);
  for (const [count, locations, label] of [
    ["s", "statementMap", "statement"],
    ["f", "fnMap", "function"],
    ["b", "branchMap", "branch"],
  ] as const) {
    if (!entry[count] || !entry[locations]) {
      throw new Error(`Missing ${label} data for ${expected.path}`);
    }
    if (
      JSON.stringify(entry[locations]) !== JSON.stringify(expected[locations])
    ) {
      throw new Error(
        `Coverage layout mismatch for ${expected.path}: ${locations}`,
      );
    }
  }
  validateFilePath(entry.path, expected.path);
  return {
    path: expected.path,
    statementMap: expected.statementMap,
    fnMap: expected.fnMap,
    branchMap: expected.branchMap,
    s: numbers(entry.s, Object.keys(expected.s)),
    f: numbers(entry.f, Object.keys(expected.f)),
    b: branches(entry.b, expected.b),
  };
}

function validateFilePath(actual: unknown, expected: string) {
  if (actual !== expected) throw new Error("Coverage file path mismatch");
}

function validateIdentity(value: unknown, identity: CoverageIdentity) {
  if (object(value).version !== 1)
    throw new Error("Incompatible coverage report");
  const entry = participant(value);
  if (entry.layout !== identity.layout)
    throw new Error("Incompatible coverage report");
  if (entry.runId !== identity.runId) throw new Error("Stale coverage report");
  return entry;
}

function killedParticipant(value: unknown, identity: CoverageIdentity) {
  const entry = validateIdentity(value, identity);
  if (object(value).signal !== "SIGKILL")
    throw new Error("Invalid forced-child declaration");
  return { ...entry, signal: "SIGKILL" };
}

export function coverageRecord(
  value: unknown,
  baseline: CoverageMapData,
  identity: CoverageIdentity,
) {
  const entry = object(value);
  const owner = validateIdentity(value, identity);
  if (entry.completion !== "complete" && entry.completion !== "checkpoint") {
    throw new Error("Invalid coverage completion status");
  }
  if (!entry.coverage) throw new Error("Missing coverage object");

  const coverage: CoverageMapData = {};
  for (const [path, data] of Object.entries(object(entry.coverage))) {
    const expected = baseline[path];
    coverage[path] = declaredFileCoverage(data, expected, path);
  }
  return { ...owner, coverage, completion: entry.completion };
}

function declaredFileCoverage(
  value: unknown,
  expected: FileCoverageData | undefined,
  path: string,
) {
  if (!expected) throw new Error(`Undeclared production file ${path}`);
  return fileCoverage(value, expected);
}

function ownedKill(
  forced: ReturnType<typeof killedParticipant> | undefined,
  parent: number,
) {
  return forced !== undefined && forced.ppid === parent;
}

function requireCompletion(
  owner: CoverageParticipant,
  report: ReturnType<typeof coverageRecord> | undefined,
  forced: ReturnType<typeof killedParticipant> | undefined,
) {
  if (!report)
    throw new Error(`Missing coverage report for started process ${owner.pid}`);
  if (report.ppid !== owner.ppid)
    throw new Error("Coverage process parent mismatch");
  if (report.completion === "complete") return;
  if (!ownedKill(forced, owner.ppid)) {
    throw new Error(
      `Missing completed coverage report for started process ${owner.pid}`,
    );
  }
}

export function mergeChecked(
  baseline: CoverageMapData,
  records: unknown[],
  started: unknown[],
  identity: CoverageIdentity,
  killed: unknown[] = [],
) {
  if (!records.length) throw new Error("Missing coverage reports");
  const owners = started.map((entry) => validateIdentity(entry, identity));
  const forced = killed.map((entry) => killedParticipant(entry, identity));
  validateKilled(forced, owners);
  const validated = records.map((entry) =>
    coverageRecord(entry, baseline, identity),
  );
  for (const owner of owners) {
    requireCompletion(
      owner,
      validated.find((entry) => entry.pid === owner.pid),
      forced.find((entry) => entry.pid === owner.pid),
    );
  }
  return mergeRecords(baseline, validated, owners);
}

function validateKilled(
  killed: ReturnType<typeof killedParticipant>[],
  owners: CoverageParticipant[],
) {
  for (const forced of killed) {
    const owner = owners.find((entry) => entry.pid === forced.pid);
    if (!owner) throw new Error(`Unregistered forced child ${forced.pid}`);
    if (owner.ppid !== forced.ppid)
      throw new Error(`Unowned forced child ${forced.pid}`);
  }
}

function mergeRecords(
  baseline: CoverageMapData,
  validated: ReturnType<typeof coverageRecord>[],
  owners: CoverageParticipant[],
) {
  const map = createCoverageMap(baseline);
  const seen = new Set();
  for (const entry of validated) {
    if (!owners.some((owner) => owner.pid === entry.pid))
      throw new Error(`Unregistered coverage process ${entry.pid}`);
    if (seen.has(entry.pid))
      throw new Error(`Duplicate coverage report ${entry.pid}`);
    seen.add(entry.pid);
    map.merge(entry.coverage);
  }
  return map;
}
