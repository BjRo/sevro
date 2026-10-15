import { createCoverageMap, type CoverageMapData } from "istanbul-lib-coverage";
import { object } from "./records";
import { checkedCoverage } from "./gate";
import { coverageDigest, type TestShard } from "./shard-plan";

export interface ShardContext {
  candidate: string;
  batch: string;
  platform: string;
  arch: string;
  bun: string;
  layout: string;
  baseline: CoverageMapData;
  plan: TestShard[];
}

function requireMetadata(
  manifest: Record<string, unknown>,
  expected: ShardContext,
) {
  if (manifest.format !== "sevro.coverage-shard.v1")
    throw new Error("Incompatible coverage shard");
  for (const key of [
    "candidate",
    "batch",
    "platform",
    "arch",
    "bun",
    "layout",
  ] as const)
    if (manifest[key] !== expected[key])
      throw new Error(`Coverage shard ${key} mismatch`);
  return requireRunId(manifest.runId);
}

function requireRunId(value: unknown) {
  if (typeof value !== "string" || !value)
    throw new Error("Missing coverage shard run identity");
  return value;
}

function requireShard(value: unknown, plan: TestShard[]) {
  const shard = object(value);
  const expected = plan.find(({ index }) => index === shard.index);
  if (!expected || coverageDigest(shard) !== coverageDigest(expected))
    throw new Error("Coverage shard assignment mismatch");
  return expected.index;
}

function completeCoverage(value: unknown, baseline: CoverageMapData) {
  const coverage = object(value);
  const found = Object.keys(coverage).sort();
  if (coverageDigest(found) !== coverageDigest(Object.keys(baseline).sort()))
    throw new Error("Incomplete coverage shard source inventory");
  return checkedCoverage(coverage, baseline);
}

export function mergeShardResults(inputs: unknown[], expected: ShardContext) {
  if (inputs.length !== expected.plan.length)
    throw new Error("Missing coverage shards");
  const map = createCoverageMap(expected.baseline);
  const seen = new Set<number>();
  const runs = new Set<string>();
  for (const input of inputs) {
    const manifest = object(input);
    const runId = requireMetadata(manifest, expected);
    const index = requireShard(manifest.shard, expected.plan);
    if (seen.has(index) || runs.has(runId))
      throw new Error("Duplicate coverage shard");
    seen.add(index);
    runs.add(runId);
    map.merge(completeCoverage(manifest.coverage, expected.baseline));
  }
  return map;
}
