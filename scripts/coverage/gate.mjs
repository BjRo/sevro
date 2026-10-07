import { createCoverageMap } from "istanbul-lib-coverage";
import { object, participant, numbers, branches } from "./records.mjs";

/** @param {import('istanbul-lib-coverage').CoverageMap} map */
export function thresholdFailure(map) {
  const summary = map.getCoverageSummary().toJSON();
  const failed = /** @type {const} */ (["statements", "branches"]).filter(
    (metric) => summary[metric].covered * 100 < summary[metric].total * 95,
  );
  if (failed.length) throw new Error(`Below 95%: ${failed.join(", ")}`);
  return summary;
}

/** @param {unknown} value @param {import('istanbul-lib-coverage').FileCoverageData} expected */
function fileCoverage(value, expected) {
  const entry = object(value);
  for (const [count, locations, label] of /** @type {const} */ ([
    ["s", "statementMap", "statement"],
    ["f", "fnMap", "function"],
    ["b", "branchMap", "branch"],
  ])) {
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

/** @param {unknown} actual @param {string} expected */
function validateFilePath(actual, expected) {
  if (actual !== expected) throw new Error("Coverage file path mismatch");
}

/** @param {unknown} value @param {import('./types').CoverageIdentity} identity */
function validateIdentity(value, identity) {
  if (object(value).version !== 1)
    throw new Error("Incompatible coverage report");
  const entry = participant(value);
  if (entry.layout !== identity.layout)
    throw new Error("Incompatible coverage report");
  if (entry.runId !== identity.runId) throw new Error("Stale coverage report");
  return entry;
}

/** @param {unknown} value @param {import('./types').CoverageIdentity} identity */
function killedParticipant(value, identity) {
  const entry = validateIdentity(value, identity);
  if (object(value).signal !== "SIGKILL")
    throw new Error("Invalid forced-child declaration");
  return { ...entry, signal: "SIGKILL" };
}

/** @param {unknown} value @param {import('istanbul-lib-coverage').CoverageMapData} baseline
 * @param {import('./types').CoverageIdentity} identity */
export function coverageRecord(value, baseline, identity) {
  const entry = object(value);
  const owner = validateIdentity(value, identity);
  if (entry.completion !== "complete" && entry.completion !== "checkpoint") {
    throw new Error("Invalid coverage completion status");
  }
  if (!entry.coverage) throw new Error("Missing coverage object");
  /** @type {import('istanbul-lib-coverage').CoverageMapData} */
  const coverage = {};
  for (const [path, data] of Object.entries(object(entry.coverage))) {
    const expected = baseline[path];
    coverage[path] = declaredFileCoverage(data, expected, path);
  }
  return { ...owner, coverage, completion: entry.completion };
}

/** @param {unknown} value @param {import('istanbul-lib-coverage').FileCoverageData | undefined} expected @param {string} path */
function declaredFileCoverage(value, expected, path) {
  if (!expected) throw new Error(`Undeclared production file ${path}`);
  return fileCoverage(value, expected);
}

/** @param {ReturnType<typeof killedParticipant> | undefined} forced @param {number} parent */
function ownedKill(forced, parent) {
  return forced !== undefined && forced.ppid === parent;
}

/** @param {import('./types').CoverageParticipant} owner
 * @param {ReturnType<typeof coverageRecord> | undefined} report
 * @param {ReturnType<typeof killedParticipant> | undefined} forced */
function requireCompletion(owner, report, forced) {
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

/** @param {import('istanbul-lib-coverage').CoverageMapData} baseline
 * @param {unknown[]} records @param {unknown[]} started
 * @param {import('./types').CoverageIdentity} identity @param {unknown[]} killed */
export function mergeChecked(
  baseline,
  records,
  started,
  identity,
  killed = [],
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

/** @param {ReturnType<typeof killedParticipant>[]} killed @param {import('./types').CoverageParticipant[]} owners */
function validateKilled(killed, owners) {
  for (const forced of killed) {
    const owner = owners.find((entry) => entry.pid === forced.pid);
    if (!owner) throw new Error(`Unregistered forced child ${forced.pid}`);
    if (owner.ppid !== forced.ppid)
      throw new Error(`Unowned forced child ${forced.pid}`);
  }
}

/** @param {import('istanbul-lib-coverage').CoverageMapData} baseline
 * @param {ReturnType<typeof coverageRecord>[]} validated @param {import('./types').CoverageParticipant[]} owners */
function mergeRecords(baseline, validated, owners) {
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
