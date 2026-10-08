import type { CoverageIdentity } from "./types";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { prepare, copySnapshot } from "./prepare";
import { mergeChecked } from "./gate";
import { loadReports } from "./run";

function pristineCandidate(repo: string, root: string) {
  const original = process.env.SEVRO_COVERAGE_SOURCE_ROOT;
  if (!original) return repo;
  const snapshot = copySnapshot(repo, join(root, "candidate"));
  cpSync(join(original, "src"), join(snapshot.project, "src"), {
    recursive: true,
  });
  return snapshot.project;
}

function exerciseScope(
  prepared: ReturnType<typeof prepare>,
  root: string,
  reports: string,
  identity: CoverageIdentity,
) {
  const script = join(root, "exercise.ts");
  writeFileSync(
    script,
    `import { isRecord } from ${JSON.stringify(join(prepared.project, "src/value-guards.ts"))};\n` +
      `import validate from ${JSON.stringify(join(prepared.project, "src/generated/extension.cjs"))};\n` +
      `const message = {protocol:"sevro.discovery.v1",id:"request-1",method:"describe",params:{protocols:["sevro.extension.v1"],engineCapabilities:[],hostCapabilities:[]}};\n` +
      `if (!isRecord(message) || !validate(message) || validate({})) throw new Error("Generated CJS validation failed");\n`,
  );
  const child = Bun.spawnSync([process.execPath, script], {
    cwd: prepared.project,
    env: {
      ...process.env,
      SEVRO_COVERAGE_REPORTS: reports,
      SEVRO_COVERAGE_RUN_ID: identity.runId,
      SEVRO_COVERAGE_LAYOUT: identity.layout,
      SEVRO_COVERAGE_SOURCE_ROOT: prepared.source,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0)
    throw new Error(`Scope runtime probe failed: ${child.stderr.toString()}`);
}

export function coverageScopeProbe(repo: string) {
  const root = mkdtempSync(join(tmpdir(), "sevro-coverage-scope-"));
  const prepared = prepare(pristineCandidate(repo, root), join(root, "run"));
  const reports = join(root, "reports");
  mkdirSync(reports);
  const identity = { version: 1, runId: randomUUID(), layout: prepared.layout };
  exerciseScope(prepared, root, reports, identity);
  const collection = loadReports(reports, prepared.baseline, identity);
  const map = mergeChecked(
    prepared.baseline,
    collection.records,
    collection.started,
    identity,
    collection.killed,
  );
  const output = join(repo, ".quality/coverage-scope");
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, "baseline.json"),
    JSON.stringify(prepared.baseline),
  );
  writeFileSync(
    join(output, "coverage-final.json"),
    JSON.stringify(map.toJSON()),
  );
  writeFileSync(
    join(output, "run.json"),
    JSON.stringify(
      { root, ...identity, summary: map.getCoverageSummary().toJSON() },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ root, output, generatedCjs: "validated" }));
}
