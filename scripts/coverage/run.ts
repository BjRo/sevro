import type {
  CoverageMap,
  CoverageMapData,
  CoverageSummaryData,
} from "istanbul-lib-coverage";
import type { CoverageIdentity, CoverageParticipant } from "./types";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createContext } from "istanbul-lib-report";
import reports from "istanbul-reports";
import { prepare } from "./prepare";
import { platformBranchCoverage } from "./platform-branches";
import { mergeChecked, coverageRecord } from "./gate";
import { participant, object } from "./records";

export function runCoverage(repo: string, testArguments: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "sevro-typescript-quality-"));
  const prepared = prepare(repo, root);
  console.log(
    JSON.stringify({
      snapshot: root,
      content: prepared.content,
      layout: prepared.layout,
    }),
  );
  const directory = join(root, "reports");
  mkdirSync(directory);
  const identity = { version: 1, runId: randomUUID(), layout: prepared.layout };
  const env = {
    ...process.env,
    SEVRO_COVERAGE_REPORTS: directory,
    SEVRO_COVERAGE_RUN_ID: identity.runId,
    SEVRO_COVERAGE_LAYOUT: identity.layout,
    SEVRO_COVERAGE_SOURCE_ROOT: prepared.source,
  };
  foreignCli(prepared, env, directory, identity);
  const child = runTests(prepared.project, env, testArguments, root);
  const collection = loadReports(directory, prepared.baseline, identity);
  const { started, killed, records } = collection;
  console.log(
    JSON.stringify({
      root,
      exitCode: child.exitCode,
      participants: started.length,
      forcedChildren: killed.length,
    }),
  );
  const raw = mergeChecked(
    prepared.baseline,
    records,
    started,
    identity,
    killed,
  );
  const projected = platformBranchCoverage(raw, prepared.source);
  const map = projected.map;
  const output = join(
    repo,
    testArguments.length ? ".quality/coverage-targeted" : ".quality/coverage",
  );
  publishReports(output, map);
  writeFileSync(
    join(output, "coverage-raw.json"),
    JSON.stringify(raw.toJSON()),
  );
  writeFileSync(
    join(output, "run.json"),
    JSON.stringify(
      {
        ...identity,
        scope: { ...prepared.scope, branchExclusions: projected.exclusions },
        root,
        exitCode: child.exitCode,
        processes: started,
        forcedChildren: killed,
        summary: map.getCoverageSummary().toJSON(),
        rawSummary: raw.getCoverageSummary().toJSON(),
      },
      null,
      2,
    ),
  );
  retainInputs(root, output, prepared.source);
  if (child.exitCode !== 0)
    throw new Error(
      `Deterministic Bun tests failed with exit ${child.exitCode}`,
    );
  enforceCoverage(
    output,
    prepared.scope,
    projected.exclusions,
    map.getCoverageSummary().toJSON(),
  );
  return map;
}

function enforceCoverage(
  output: string,
  scope: ReturnType<typeof prepare>["scope"],
  branchExclusions: ReturnType<typeof platformBranchCoverage>["exclusions"],
  summary: CoverageSummaryData,
) {
  const enforcement = {
    scope: { ...scope, branchExclusions },
    summary,
  };
  writeFileSync(
    join(output, "enforcement.json"),
    JSON.stringify(enforcement, null, 2),
  );
  console.log(JSON.stringify(enforcement));
  enforceThresholds(summary);
}

export function enforceThresholds(summary: CoverageSummaryData) {
  const failed = (["statements", "branches"] as const).filter(
    (metric) => summary[metric].covered * 100 < summary[metric].total * 95,
  );
  if (failed.length) throw new Error(`Below 95%: ${failed.join(", ")}`);
}

function retainInputs(root: string, output: string, source: string) {
  for (const file of ["baseline.json", "snapshot.json", "tests.log"])
    cpSync(join(root, file), join(output, file));
  cpSync(source, join(output, "source"), { recursive: true });
}

function runTests(
  project: string,
  env: NodeJS.ProcessEnv,
  testArguments: string[],
  root: string,
) {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "test",
      ...testArguments,
      "--timeout",
      "15000",
      "--max-concurrency",
      "4",
    ],
    { cwd: project, env, stdout: "pipe", stderr: "pipe" },
  );
  const output = child.stdout.toString() + child.stderr.toString();
  writeFileSync(join(root, "tests.log"), output);
  console.log(output);
  return child;
}

export function loadReports(
  directory: string,
  baseline: CoverageMapData,
  identity: CoverageIdentity,
) {
  const names = readdirSync(directory);
  for (const name of names) requireReportName(name);

  const load = (name: string): unknown => {
    const value = JSON.parse(
      readFileSync(join(directory, name), "utf8"),
    ) as unknown;
    const entry = participant(value);
    if (!name.startsWith(`${entry.pid}.`))
      throw new Error("Coverage report filename identity mismatch");
    requireCompletionName(name, value);
    return value;
  };
  const started = names
    .filter((name) => name.endsWith(".started.json"))
    .map(load)
    .map(participant);
  const killed = names
    .filter((name) => name.endsWith(".killed.json"))
    .map(load);
  const snapshots = names
    .filter(snapshotName)
    .map(load)
    .map((value) => coverageRecord(value, baseline, identity));
  requireRegisteredSnapshots(snapshots, started);
  const records = started.flatMap((record) => {
    const complete = `${record.pid}.complete.json`;
    const checkpoint = `${record.pid}.checkpoint.json`;
    if (names.includes(complete)) return [load(complete)];
    if (names.includes(checkpoint)) return [load(checkpoint)];
    return [];
  });
  return { started, killed, records };
}

function requireReportName(name: string) {
  if (
    !/^\d+\.(?:started|killed|complete|checkpoint)\.json(?:\.\d+\.tmp)?$/.test(
      name,
    )
  )
    throw new Error(`Unexpected coverage report file: ${name}`);
}

function requireCompletionName(name: string, value: unknown) {
  if (!snapshotName(name)) return;
  const completion = object(value).completion;
  if (!name.endsWith(`.${String(completion)}.json`))
    throw new Error("Coverage report completion filename mismatch");
}

function snapshotName(name: string) {
  return name.endsWith(".complete.json") || name.endsWith(".checkpoint.json");
}

function requireRegisteredSnapshots(
  snapshots: ReturnType<typeof coverageRecord>[],
  started: CoverageParticipant[],
) {
  for (const report of snapshots) {
    if (!started.some((owner) => owner.pid === report.pid))
      throw new Error(`Unregistered coverage process ${report.pid}`);
  }
}

function publishReports(output: string, map: CoverageMap) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const context = createContext({ dir: output, coverageMap: map });
  for (const type of ["json", "json-summary", "lcovonly", "html"] as const)
    reports.create(type).execute(context);
}

function requireForeignCli(
  directory: string,
  pid: number,
  baseline: CoverageMapData,
  identity: CoverageIdentity,
  cli: string,
) {
  const load = (kind: string) =>
    JSON.parse(
      readFileSync(join(directory, `${pid}.${kind}.json`), "utf8"),
    ) as unknown;
  const started = participant(load("started"));
  const complete = coverageRecord(load("complete"), baseline, identity);
  if (
    started.pid !== pid ||
    complete.pid !== pid ||
    complete.completion !== "complete"
  )
    throw new Error("Foreign-working-directory CLI completion mismatch");
  requireCoveredCli(complete.coverage, cli);
  console.log("foreign-working-directory-cli: registered and collected");
}

function requireCoveredCli(coverage: CoverageMapData, cli: string) {
  const counts = coverage[cli]?.s;
  if (!counts || !Object.values(counts).some((count) => count > 0))
    throw new Error(
      "Foreign-working-directory CLI production coverage missing",
    );
}

function foreignCli(
  prepared: ReturnType<typeof prepare>,
  env: NodeJS.ProcessEnv,
  directory: string,
  identity: CoverageIdentity,
) {
  const foreign = Bun.spawnSync(
    [process.execPath, join(prepared.project, "src/cli.ts"), "run", "--json"],
    { cwd: tmpdir(), env, stdout: "pipe", stderr: "pipe" },
  );
  if (foreign.exitCode !== 64)
    throw new Error(
      "Foreign-working-directory CLI probe did not produce the expected refusal",
    );
  requireForeignCli(
    directory,
    foreign.pid,
    prepared.baseline,
    identity,
    join(prepared.source, "src/cli.ts"),
  );
}
