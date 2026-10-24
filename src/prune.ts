import { lstat, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assertCliResult, assertRunEvidence } from "./schema";
import type { CliResultData, RunEvidenceData } from "./schema-types";
import { createReport } from "./report";
import { atomicWriteJson } from "./storage";
import { isRecord } from "./value-guards";
import {
  acquireResultsLock,
  retainedFile,
  withResultsLock,
} from "./results-lock";
import { pruneNativeTranscripts } from "./transcript-retention";

interface RetainedResult {
  directory: string;
  result: CliResultData;
  evidence: RunEvidenceData;
  time: number;
}

interface RetainedStorage {
  directories: string[];
  roots: string[];
  releases: (() => void)[];
}

type RetentionPolicy =
  { keep: number; cutoff: null } | { keep: null; cutoff: number };

const durationUnits: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function duration(value: string): number {
  const match = /^([1-9]\d*)(ms|s|m|h|d|w)$/.exec(value);
  if (!match)
    throw new Error(
      "--older-than requires a positive integer and ms, s, m, h, d or w",
    );
  const amount =
    Number.parseInt(value, 10) *
    Number(durationUnits[value.replace(/^\d+/, "")]);
  if (!Number.isSafeInteger(amount))
    throw new Error("--older-than exceeds the safe duration range");
  return amount;
}

function count(value: string): number {
  const amount = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(amount))
    throw new Error("--keep must be a positive safe integer");
  return amount;
}

function parseInvocation(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      "results-root": { type: "string" },
      keep: { type: "string" },
      latest: { type: "boolean" },
      "older-than": { type: "string" },
      "native-transcripts": { type: "boolean" },
    },
  });
  return values;
}

function policy(values: ReturnType<typeof parseInvocation>): RetentionPolicy {
  if (values.latest) return { keep: 1, cutoff: null };
  if (values["older-than"] !== undefined)
    return { keep: null, cutoff: Date.now() - duration(values["older-than"]) };
  if (values.keep !== undefined)
    return { keep: count(values.keep), cutoff: null };
  return { keep: values["native-transcripts"] ? 0 : 10, cutoff: null };
}

function invocation(args: string[]) {
  const values = parseInvocation(args);
  const policies = [values.latest, values.keep, values["older-than"]].filter(
    (value) => value !== undefined,
  );
  if (policies.length > 1) throw new Error("retention policies are exclusive");
  if (values["results-root"] === "")
    throw new Error("--results-root must not be empty");
  return {
    root: resolve(values["results-root"] ?? ".sevro/results"),
    policy: policy(values),
    nativeTranscripts: values["native-transcripts"] === true,
  };
}

async function retainedResults(
  root: string,
  directories: string[],
): Promise<RetainedResult[]> {
  const results: RetainedResult[] = [];
  for (const directory of directories) {
    const path = join(directory, "result.json");
    await retainedFile(path);
    const result: unknown = JSON.parse(await readFile(path, "utf8"));
    assertCliResult(result);
    if (!(await finalizedAncestors(root, directory, result.runId))) continue;
    if (result.evidencePath !== join(directory, "run.json"))
      throw new Error(
        `retained result references evidence outside its directory: ${path}`,
      );
    await retainedFile(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    await createReport([path]);
    results.push({
      directory,
      result,
      evidence,
      time: (await stat(path)).mtimeMs,
    });
  }
  return results.sort(
    (left, right) =>
      right.time - left.time || left.directory.localeCompare(right.directory),
  );
}

async function resultDirectories(
  parent: string,
  storage: RetainedStorage,
): Promise<void> {
  let children = await resultChildren(parent);
  if (
    !storage.roots.includes(parent) &&
    ((await resultsRoot(parent)) || children.results.length > 0)
  ) {
    storage.releases.push(await acquireResultsLock(parent));
    storage.roots.push(parent);
    children = await resultChildren(parent);
  }
  storage.directories.push(...children.results);
  for (const directory of children.containers)
    await resultDirectories(directory, storage);
}

async function resultChildren(parent: string) {
  const results: string[] = [];
  const containers: string[] = [];
  const entries = await readdir(parent, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;
    const directory = join(parent, entry.name);
    if (await retainedFile(join(directory, "result.json")))
      results.push(directory);
    else containers.push(directory);
  }
  return { results, containers };
}

async function resultsRoot(directory: string): Promise<boolean> {
  const active = await lstat(join(directory, "active")).catch(
    (cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    },
  );
  if (active && !active.isDirectory())
    throw new Error(`retained ownership must be a directory: ${directory}`);
  return Boolean(
    active || (await retainedFile(join(directory, ".retention-lock.sqlite"))),
  );
}

async function finalized(root: string, runId: string | null): Promise<boolean> {
  if (!runId || basename(runId) !== runId) return false;
  const path = join(root, "active", `${runId}.json`);
  if (!(await retainedFile(path))) return true;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) return false;
  return finalizedRecord(value, runId);
}

async function finalizedAncestors(
  root: string,
  directory: string,
  runId: string | null,
): Promise<boolean> {
  let ancestor = dirname(directory);
  while (ancestor !== dirname(root)) {
    if (!(await finalized(ancestor, runId))) return false;
    ancestor = dirname(ancestor);
  }
  return true;
}

function finalizedRecord(
  value: Record<string, unknown>,
  runId: string,
): boolean {
  return (
    value.format === "sevro.active-run.v1" &&
    value.runId === runId &&
    ["complete", "interrupted", "diagnostic"].includes(String(value.status))
  );
}

function retainedByPolicy(results: RetainedResult[], policy: RetentionPolicy) {
  const cutoff = policy.cutoff;
  return cutoff === null
    ? results.slice(0, policy.keep)
    : results.filter((result) => result.time >= cutoff);
}

async function pruneResults(
  root: string,
  policy: RetentionPolicy,
  storage: RetainedStorage,
) {
  const results = await retainedResults(root, storage.directories);
  const remaining = retainedByPolicy(results, policy);
  for (const resultsRoot of storage.roots) {
    const latest = remaining.find((item) =>
      item.directory.startsWith(`${resultsRoot}/`),
    );
    if (latest)
      await atomicWriteJson(join(resultsRoot, "latest.json"), latest.result);
    else await rm(join(resultsRoot, "latest.json"), { force: true });
  }
  const removed = results.filter((result) => !remaining.includes(result));
  for (const result of removed) await rm(result.directory, { recursive: true });
  return { removed: removed.length, kept: remaining.length };
}

async function pruneTranscripts(
  root: string,
  policy: RetentionPolicy,
  directories: string[],
) {
  const results = await retainedResults(root, directories);
  const preserved = retainedByPolicy(results, policy);
  let removed = 0;
  for (const { evidence } of results.filter(
    (item) => !preserved.includes(item),
  )) {
    removed += await pruneNativeTranscripts(evidence);
  }
  return { removed, kept: results.length };
}

async function prune(options: ReturnType<typeof invocation>) {
  const root = await realpath(options.root).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
  if (root === null) return { removed: 0, kept: 0 };
  return withResultsLock(root, async () => {
    const storage: RetainedStorage = {
      directories: [],
      roots: [root],
      releases: [],
    };
    try {
      await resultDirectories(root, storage);
      return options.nativeTranscripts
        ? await pruneTranscripts(root, options.policy, storage.directories)
        : await pruneResults(root, options.policy, storage);
    } finally {
      for (const release of storage.releases.reverse()) release();
    }
  });
}

/** Explicitly remove old retained runs while keeping report's latest index usable. */
export async function pruneCommand(args: string[]): Promise<number> {
  try {
    const options = invocation(args);
    const result = await prune(options);
    const unit = options.nativeTranscripts
      ? "native transcript bundle(s)"
      : "result(s)";
    process.stdout.write(
      `Removed ${result.removed} ${unit}; kept ${result.kept}${options.nativeTranscripts ? " result(s)" : ""}.\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `sevro prune: ${error instanceof Error ? error.message : "pruning failed"}\n`,
    );
    return 64;
  }
}
