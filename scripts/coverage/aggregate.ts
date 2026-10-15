import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepare } from "./prepare";
import { coverageBatch, testShards } from "./shard-plan";
import { coverageLayout, relocateCoverage } from "./shard-output";
import { mergeShardResults } from "./shard-merge";
import { platformBranchCoverage } from "./platform-branches";
import { enforceCoverage, publishReports, retainInputs } from "./run";
import { object } from "./records";
import { createCoverageMap } from "istanbul-lib-coverage";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function shardInputs(directory: string, count: number) {
  const names = Array.from({ length: count }, (_, index) => String(index + 1));
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(names))
    throw new Error("Expected exactly one artifact for every coverage shard");
  return names.map((name) => ({
    ...object(readJson(join(directory, name, "shard.json"))),
    coverage: readJson(join(directory, name, "coverage-portable.json")),
  }));
}

export function aggregateCoverage(repo: string, directory: string) {
  const root = mkdtempSync(join(tmpdir(), "sevro-coverage-aggregate-"));
  const prepared = prepare(repo, root);
  const plan = testShards(repo);
  const inputs = shardInputs(directory, plan.length);
  const baseline = relocateCoverage(prepared.baseline, prepared.source, ".");
  const portable = mergeShardResults(inputs, {
    candidate: prepared.content,
    batch: coverageBatch(),
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    layout: coverageLayout(baseline),
    baseline,
    plan,
  });
  const raw = relocateCoverage(portable.toJSON(), ".", prepared.source);
  const projected = platformBranchCoverage(
    // Portable maps must be rooted at the retained snapshot for source inspection.
    createCoverageMap(raw),
    prepared.source,
  );
  const output = join(repo, ".quality/coverage");
  publishReports(output, projected.map);
  writeFileSync(join(output, "coverage-raw.json"), JSON.stringify(raw));
  writeFileSync(
    join(output, "run.json"),
    JSON.stringify(
      {
        candidate: prepared.content,
        batch: coverageBatch(),
        scope: { ...prepared.scope, branchExclusions: projected.exclusions },
        shards: inputs.map((input) => ({
          shard: object(input).shard,
          runId: object(input).runId,
          attempt: object(input).attempt,
        })),
        summary: projected.map.getCoverageSummary().toJSON(),
        rawSummary: portable.getCoverageSummary().toJSON(),
      },
      null,
      2,
    ),
  );
  const logs = plan.map(
    ({ index }) =>
      `Shard ${index}\n${readFileSync(join(directory, String(index), "tests.log"), "utf8")}`,
  );
  writeFileSync(join(root, "tests.log"), logs.join("\n"));
  retainInputs(root, output, prepared.source);
  enforceCoverage(
    output,
    prepared.scope,
    projected.exclusions,
    projected.map.getCoverageSummary().toJSON(),
  );
}
