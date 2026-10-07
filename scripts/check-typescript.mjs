import { createInstrumenter } from "istanbul-lib-instrument";
import { createCoverageMap } from "istanbul-lib-coverage";
import { mergeChecked } from "./coverage/gate.mjs";
import { runCoverage } from "./coverage/run.mjs";
import { resolve } from "node:path";
import { checkInventory } from "./typescript-inventory.mjs";
import { runInNewContext } from "node:vm";
import { integrityProbes } from "./coverage/probes.mjs";
import { sourceMapProbe } from "./coverage/source-map-probe.mjs";
import { exemptionProbe } from "./coverage/exemptions";
import { compilerFlowProbe } from "./coverage/compiler-flow-probes";
import { snapshotProbe } from "./coverage/snapshot-probe";

/** @param {string[]} command @param {string} root */
function run(command, root) {
  const child = Bun.spawnSync(command, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (child.exitCode !== 0)
    throw new Error(`${command.join(" ")} exited ${child.exitCode}`);
}

/** @param {boolean} fast */
async function qualityGate(fast) {
  const root = resolve(import.meta.dir, "..");
  await checkInventory(root);
  if (!fast) run([process.execPath, "install", "--frozen-lockfile"], root);
  for (const name of [
    "schemas:check",
    "check:docs",
    "format:check",
    "lint",
    "typecheck",
  ]) {
    run([process.execPath, "run", name], root);
  }
  if (fast) return;
  run(
    [process.execPath, "run", "eval:guide", "--host", "codex", "--dry"],
    root,
  );
  run([process.execPath, "run", "test:docs-examples"], root);
  integrityProbes();
  sourceMapProbe();
  exemptionProbe(root);
  compilerFlowProbe();
  snapshotProbe(root);
  runCoverage(root);
  run([process.execPath, "run", "test:package-install"], root);
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
  /** @type {{__coverage__?: import('istanbul-lib-coverage').CoverageMapData}} */
  const context = {};
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
  for (const metric of /** @type {const} */ (["statements", "branches"])) {
    if (summary[metric].covered * 100 < summary[metric].total * 95) {
      throw new Error(`Below 95%: ${metric}`);
    }
  }
}

try {
  if (process.argv.slice(2).join(" ") === "--probe branch") branchProbe();
  else if (process.argv.slice(2).join(" ") === "--probe integrity")
    integrityProbes();
  else if (process.argv.slice(2).join(" ") === "--probe source-map")
    sourceMapProbe();
  else if (process.argv.slice(2).join(" ") === "--probe exemptions")
    exemptionProbe(resolve(import.meta.dir, ".."));
  else if (process.argv.slice(2).join(" ") === "--probe compiler-flow")
    compilerFlowProbe();
  else if (process.argv.slice(2).join(" ") === "--probe snapshot")
    snapshotProbe(resolve(import.meta.dir, ".."));
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
  } else if (process.argv.length === 2) await qualityGate(false);
  else if (process.argv.slice(2).join(" ") === "--fast")
    await qualityGate(true);
  else
    throw new Error(
      "Expected --fast, --inventory [root], --coverage [Bun test arguments], or --probe <name>",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
