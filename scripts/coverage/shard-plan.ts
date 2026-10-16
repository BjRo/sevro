import { createHash } from "node:crypto";
import { sourceInventory } from "../typescript-inventory";
import durations from "./test-durations.json";

export const shardCount = 4;
const weights: Record<string, number> = durations;

export interface TestShard {
  index: number;
  count: number;
  files: string[];
}

export function shardIndex(value: string | undefined) {
  const match = /^([1-4])\/4$/.exec(value ?? "");
  if (!match) throw new Error("Expected --shard 1/4|2/4|3/4|4/4");
  return Number(match[1]);
}

export function testShards(root: string): TestShard[] {
  const files = Object.values(sourceInventory(root))
    .flat()
    .filter((file) =>
      /(?:\.test|_test|\.spec|_spec)\.[cm]?[jt]sx?$/.test(file),
    );
  return balanceTests(files, shardCount);
}

export function balanceTests(files: string[], count: number): TestShard[] {
  const shards = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    count,
    files: [] as string[],
    seconds: 0,
  }));
  const ranked = [...files].sort(
    (left, right) => weight(right) - weight(left) || left.localeCompare(right),
  );
  for (const file of ranked) {
    const next = [...shards].sort(
      (left, right) => left.seconds - right.seconds,
    )[0];
    if (!next) throw new Error("Expected at least one test shard");
    next.files.push(file);
    next.seconds += weight(file);
  }
  return shards.map(({ index, count, files }) => ({
    index,
    count,
    files: files.sort(),
  }));
}

function weight(file: string) {
  return weights[file] ?? 5;
}

export function coverageBatch() {
  return process.env.GITHUB_RUN_ID ?? "local";
}

export function coverageDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
