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
import { prepare } from "./prepare.mjs";
import { mergeChecked, coverageRecord } from "./gate.mjs";
import { exemptionCounts, readExemptions, enforceAdjusted } from "./exemptions";
import { participant, object } from "./records.mjs";

/** @param {string} repo @param {string[]} testArguments */
export function runCoverage(repo, testArguments = []) {
  const root = mkdtempSync(join(tmpdir(), "sevro-typescript-quality-"));
  const prepared = prepare(repo, root);
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
  const map = mergeChecked(
    prepared.baseline,
    records,
    started,
    identity,
    killed,
  );
  const output = join(
    repo,
    testArguments.length ? ".quality/coverage-targeted" : ".quality/coverage",
  );
  publishReports(output, map);
  writeFileSync(
    join(output, "run.json"),
    JSON.stringify(
      {
        ...identity,
        root,
        exitCode: child.exitCode,
        processes: started,
        forcedChildren: killed,
        summary: map.getCoverageSummary().toJSON(),
      },
      null,
      2,
    ),
  );
  cpSync(join(root, "baseline.json"), join(output, "baseline.json"));
  cpSync(join(root, "tests.log"), join(output, "tests.log"));
  cpSync(prepared.source, join(output, "source"), { recursive: true });
  console.log(JSON.stringify(map.getCoverageSummary().toJSON()));
  if (child.exitCode !== 0)
    throw new Error(
      `Deterministic Bun tests failed with exit ${child.exitCode}`,
    );
  const enforcement = exemptionCounts(
    map,
    prepared.source,
    readExemptions(repo),
  );
  writeFileSync(
    join(output, "enforcement.json"),
    JSON.stringify(enforcement, null, 2),
  );
  console.log(JSON.stringify(enforcement));
  enforceAdjusted(enforcement.adjusted);
  return map;
}

/** @param {string} project @param {NodeJS.ProcessEnv} env @param {string[]} testArguments @param {string} root */
function runTests(project, env, testArguments, root) {
  const child = Bun.spawnSync(
    [process.execPath, "test", ...testArguments, "--timeout", "15000"],
    { cwd: project, env, stdout: "pipe", stderr: "pipe" },
  );
  const output = child.stdout.toString() + child.stderr.toString();
  writeFileSync(join(root, "tests.log"), output);
  console.log(output);
  return child;
}

/** @param {string} directory @param {import('istanbul-lib-coverage').CoverageMapData} baseline
 * @param {import('./types').CoverageIdentity} identity */
export function loadReports(directory, baseline, identity) {
  const names = readdirSync(directory);
  for (const name of names) requireReportName(name);
  /** @param {string} name @returns {unknown} */
  const load = (name) => {
    const value = /** @type {unknown} */ (
      JSON.parse(readFileSync(join(directory, name), "utf8"))
    );
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
/** @param {string} name */
function requireReportName(name) {
  if (
    !/^\d+\.(?:started|killed|complete|checkpoint)\.json(?:\.\d+\.tmp)?$/.test(
      name,
    )
  )
    throw new Error(`Unexpected coverage report file: ${name}`);
}
/** @param {string} name @param {unknown} value */
function requireCompletionName(name, value) {
  if (!snapshotName(name)) return;
  const completion = object(value).completion;
  if (!name.endsWith(`.${String(completion)}.json`))
    throw new Error("Coverage report completion filename mismatch");
}

/** @param {string} name */
function snapshotName(name) {
  return name.endsWith(".complete.json") || name.endsWith(".checkpoint.json");
}

/** @param {ReturnType<typeof coverageRecord>[]} snapshots @param {import('./types').CoverageParticipant[]} started */
function requireRegisteredSnapshots(snapshots, started) {
  for (const report of snapshots) {
    if (!started.some((owner) => owner.pid === report.pid))
      throw new Error(`Unregistered coverage process ${report.pid}`);
  }
}

/** @param {string} output @param {import('istanbul-lib-coverage').CoverageMap} map */
function publishReports(output, map) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const context = createContext({ dir: output, coverageMap: map });
  for (const type of /** @type {const} */ ([
    "json",
    "json-summary",
    "lcovonly",
    "html",
  ]))
    reports.create(type).execute(context);
}

/** @param {string} directory @param {number} pid @param {import('istanbul-lib-coverage').CoverageMapData} baseline @param {import('./types').CoverageIdentity} identity @param {string} cli */
function requireForeignCli(directory, pid, baseline, identity, cli) {
  /** @param {string} kind */
  const load = (kind) =>
    /** @type {unknown} */ (
      JSON.parse(readFileSync(join(directory, `${pid}.${kind}.json`), "utf8"))
    );
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
/** @param {import('istanbul-lib-coverage').CoverageMapData} coverage @param {string} cli */
function requireCoveredCli(coverage, cli) {
  const counts = coverage[cli]?.s;
  if (!counts || !Object.values(counts).some((count) => count > 0))
    throw new Error(
      "Foreign-working-directory CLI production coverage missing",
    );
}

/** @param {ReturnType<typeof prepare>} prepared @param {NodeJS.ProcessEnv} env @param {string} directory @param {import('./types').CoverageIdentity} identity */
function foreignCli(prepared, env, directory, identity) {
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
