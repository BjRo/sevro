import { createInstrumenter } from "istanbul-lib-instrument";
import { createCoverageMap, type CoverageMapData } from "istanbul-lib-coverage";
import { mergeChecked } from "./coverage/gate";
import { runCoverage, enforceThresholds } from "./coverage/run";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { object } from "./coverage/records";
import { checkInventory } from "./typescript-inventory";
import { runInNewContext } from "node:vm";
import { integrityProbes } from "./coverage/probes";
import { sourceMapProbe } from "./coverage/source-map-probe";
import { snapshotProbe } from "./coverage/snapshot-probe";
import { coverageScopeProbe } from "./coverage/scope-probe";
import { aggregateCoverage } from "./coverage/aggregate";
import { shardIndex, testShards } from "./coverage/shard-plan";

function run(command: string[], root: string) {
  const child = Bun.spawnSync(command, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (child.exitCode !== 0)
    throw new Error(`${command.join(" ")} exited ${child.exitCode}`);
}

const qualityPhases = ["static", "docs", "tests", "package"] as const;
type QualityPhase = (typeof qualityPhases)[number];

async function qualityGate(
  phases: readonly QualityPhase[],
  install = false,
  mergeDirectory?: string,
) {
  const root = resolve(import.meta.dir, "..");
  await checkInventory(root);
  if (install) run([process.execPath, "install", "--frozen-lockfile"], root);
  for (const phase of phases) {
    const label = `TypeScript quality: ${phase}`;
    console.time(label);
    try {
      qualityPhase(root, phase, mergeDirectory);
    } finally {
      console.timeEnd(label);
    }
  }
}

function staticChecks(root: string) {
  for (const name of [
    "schemas:check",
    "check:docs",
    "format:check",
    "lint",
    "typecheck",
  ]) {
    run([process.execPath, "run", name], root);
  }
}

function qualityPhase(
  root: string,
  phase: QualityPhase,
  mergeDirectory?: string,
) {
  switch (phase) {
    case "static":
      staticChecks(root);
      return;
    case "docs":
      guideDryRuns(root);
      run([process.execPath, "run", "test:docs-examples"], root);
      return;
    case "tests":
      if (mergeDirectory) aggregateCoverage(root, mergeDirectory);
      else runCoverage(root);
      return;
    case "package":
      run([process.execPath, "run", "test:package-install"], root);
      return;
  }
}

function selectedPhase(value: string | undefined): QualityPhase {
  const selected = qualityPhases.find((phase) => phase === value);
  if (!selected) throw new Error(`Expected --phase ${qualityPhases.join("|")}`);
  return selected;
}

async function runShard(value: string | undefined) {
  const index = shardIndex(value);
  const root = resolve(import.meta.dir, "..");
  await checkInventory(root);
  const shard = testShards(root).find((shard) => shard.index === index);
  if (!shard?.files.length) throw new Error("Expected a nonempty test shard");
  console.log(JSON.stringify({ shard }));
  runCoverage(
    root,
    shard.files.map((file) => `./${file}`),
    shard,
  );
}

function guideDryRuns(root: string) {
  const cases: unknown = JSON.parse(
    readFileSync(
      resolve(root, ".agents/skills/sevro-guide/evals/cases.json"),
      "utf8",
    ),
  );
  if (!Array.isArray(cases)) throw new Error("Invalid guide cases");
  for (const value of cases) {
    const id = object(value).id;
    if (typeof id !== "string") throw new Error("Invalid guide case ID");
    run(
      [
        process.execPath,
        "run",
        "eval:guide",
        "--case-id",
        id,
        "--host",
        "codex",
        "--codex-bin",
        "/bin/false",
        "--codex-auth-file",
        "/unused-auth.json",
        "--model",
        "dry-unverified",
        "--effort",
        "medium",
        "--json",
        "--dry",
      ],
      root,
    );
  }
}

function branchProbe() {
  const instrumenter = createInstrumenter({
    esModules: true,
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
  });
  const code = instrumenter.instrumentSync(
    "function pick(flag) { let result = 1; if (flag) result = 2; return result; } pick(true);",
    "/probe/branch.js",
  );
  const context: { __coverage__?: CoverageMapData } = {};
  runInNewContext(code, context);
  const map = createCoverageMap(context.__coverage__ ?? {});
  const summary = map.getCoverageSummary().toJSON();
  console.log(
    JSON.stringify({
      statements: {
        covered: summary.statements.covered,
        total: summary.statements.total,
      },
      branches: {
        covered: summary.branches.covered,
        total: summary.branches.total,
      },
    }),
  );
  enforceThresholds(summary);
}

try {
  if (process.argv.slice(2).join(" ") === "--probe branch") branchProbe();
  else if (process.argv.slice(2).join(" ") === "--probe integrity")
    integrityProbes();
  else if (process.argv.slice(2).join(" ") === "--probe source-map")
    sourceMapProbe();
  else if (process.argv.slice(2).join(" ") === "--probe snapshot")
    snapshotProbe(resolve(import.meta.dir, ".."));
  else if (process.argv.slice(2).join(" ") === "--probe scope")
    coverageScopeProbe(resolve(import.meta.dir, ".."));
  else if (process.argv.slice(2).join(" ") === "--probe missing-reports") {
    mergeChecked({}, [], [], { version: 1, runId: "probe", layout: "probe" });
  } else if (process.argv[2] === "--inventory") {
    console.log(
      JSON.stringify(
        await checkInventory(process.argv[3] ?? resolve(import.meta.dir, "..")),
      ),
    );
  } else if (process.argv[2] === "--coverage") {
    runCoverage(resolve(import.meta.dir, ".."), process.argv.slice(3));
  } else if (process.argv[2] === "--shard" && process.argv.length === 4)
    await runShard(process.argv[3]);
  else if (process.argv.slice(2).join(" ") === "--shard-plan")
    console.log(
      JSON.stringify(testShards(resolve(import.meta.dir, "..")), null, 2),
    );
  else if (process.argv[2] === "--merge-shards" && process.argv.length <= 4)
    await qualityGate(
      ["tests"],
      false,
      resolve(process.argv[3] ?? ".quality/shards"),
    );
  else if (process.argv.length === 2) await qualityGate(qualityPhases, true);
  else if (process.argv.slice(2).join(" ") === "--fast")
    await qualityGate(["static"]);
  else if (process.argv[2] === "--phase" && process.argv.length === 4)
    await qualityGate([selectedPhase(process.argv[3])]);
  else
    throw new Error(
      "Expected --fast, --phase static|docs|tests|package, --inventory [root], --coverage [Bun test arguments], --shard 1/4|2/4|3/4|4/4, --shard-plan, --merge-shards [directory], or --probe <name>",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
