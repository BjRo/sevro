import type {
  CoverageMapData,
  CoverageSummaryData,
} from "istanbul-lib-coverage";
import { createInstrumenter } from "istanbul-lib-instrument";
import { mergeChecked } from "./gate";
import { loadReports } from "./run";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const path = "/probe/covered.ts";
const coldPath = "/probe/unimported.ts";
const identity = { version: 1, runId: "probe", layout: "probe-layout" };
const owner = { ...identity, pid: 1, ppid: 10, argv: ["bun", "probe"] };

function fixture() {
  const instrumenter = createInstrumenter();
  instrumenter.instrumentSync(
    "function pick(flag) { let result=1; if(flag) result=2; return result; } pick(true);",
    path,
  );
  const file = instrumenter.lastFileCoverage();
  const coldInstrumenter = createInstrumenter();
  coldInstrumenter.instrumentSync("export const value = 1;", coldPath);
  const baseline = {
    [path]: file,
    [coldPath]: coldInstrumenter.lastFileCoverage(),
  };
  const executed = structuredClone(file);
  for (const id of Object.keys(executed.s)) executed.s[id] = 1;
  for (const id of Object.keys(executed.f)) executed.f[id] = 1;
  for (const id of Object.keys(executed.b)) executed.b[id] = [1, 0];
  const record = {
    ...owner,
    completion: "complete",
    coverage: { [path]: executed },
  };
  return { baseline, record };
}

function refusal(label: string, action: () => unknown, expected: string) {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) {
      console.log(`${label}: refused`);
      return;
    }
    throw new Error(`Incorrect ${label} diagnostic`, { cause: error });
  }
  throw new Error(`${label} was accepted`);
}

export function integrityProbes() {
  const { baseline, record } = fixture();
  const map = mergeChecked(baseline, [record], [owner], identity);
  const cold = map.fileCoverageFor(coldPath).toSummary();
  if (cold.statements.total !== 1 || cold.statements.covered !== 0)
    throw new Error("Unimported production omitted");
  console.log("unimported-production: zero-counted");
  refusal(
    "missing-child",
    () =>
      mergeChecked(baseline, [record], [owner, { ...owner, pid: 2 }], identity),
    "Missing coverage report for started process 2",
  );
  const deleted = structuredClone(record);
  const entry = deleted.coverage[path];
  Reflect.deleteProperty(entry, "b");
  refusal(
    "missing-branch-data",
    () => mergeChecked(baseline, [deleted], [owner], identity),
    "Missing branch data",
  );
  refusal(
    "stale-report",
    () =>
      mergeChecked(baseline, [{ ...record, runId: "old" }], [owner], identity),
    "Stale coverage report",
  );
  refusal(
    "incompatible-report",
    () =>
      mergeChecked(baseline, [{ ...record, layout: "old" }], [owner], identity),
    "Incompatible coverage report",
  );
  const checkpoint = { ...record, completion: "checkpoint" };
  refusal(
    "normal-checkpoint",
    () => mergeChecked(baseline, [checkpoint], [owner], identity),
    "Missing completed coverage report",
  );
  refusal(
    "unowned-force-kill",
    () =>
      mergeChecked(baseline, [checkpoint], [owner], identity, [
        { ...owner, ppid: 20, signal: "SIGKILL" },
      ]),
    "Unowned forced child",
  );
  const conservative = mergeChecked(baseline, [checkpoint], [owner], identity, [
    { ...owner, signal: "SIGKILL" },
  ])
    .getCoverageSummary()
    .toJSON();
  verifyConservative(conservative);
  console.log("owned-force-kill: conservative");
  refusal(
    "missing-force-kill-checkpoint",
    () =>
      mergeChecked(baseline, [], [owner], identity, [
        { ...owner, signal: "SIGKILL" },
      ]),
    "Missing coverage reports",
  );
  storageProbes(baseline, record);
}

function storageProbes(
  baseline: CoverageMapData,
  record: ReturnType<typeof fixture>["record"],
) {
  const directory = mkdtempSync(join(tmpdir(), "sevro-report-integrity-"));

  const write = (name: string, value: unknown) => {
    writeFileSync(join(directory, name), JSON.stringify(value));
  };
  write("1.started.json", owner);
  write("1.complete.json", record);
  write("2.complete.json", { ...record, pid: 2 });
  refusal(
    "unregistered-completion",
    () => loadReports(directory, baseline, identity),
    "Unregistered coverage process 2",
  );
  rmSync(join(directory, "2.complete.json"));
  write("1.checkpoint.json", {
    ...record,
    completion: "checkpoint",
    runId: "previous",
  });
  refusal(
    "stale-discarded-checkpoint",
    () => loadReports(directory, baseline, identity),
    "Stale coverage report",
  );
  rmSync(join(directory, "1.checkpoint.json"));
  write("1.checkpoint.json", record);
  refusal(
    "misnamed-completion",
    () => loadReports(directory, baseline, identity),
    "Coverage report completion filename mismatch",
  );
  rmSync(join(directory, "1.checkpoint.json"));
  write("unrecognized.json", record);
  refusal(
    "unexpected-report-file",
    () => loadReports(directory, baseline, identity),
    "Unexpected coverage report file",
  );
}

function verifyConservative(summary: CoverageSummaryData) {
  if (summary.branches.covered !== 1 || summary.branches.total !== 2)
    throw new Error("Force-kill counters were extrapolated");
}
