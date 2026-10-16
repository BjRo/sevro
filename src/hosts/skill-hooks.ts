import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../value-guards";
import { skillHookCatalog, type SkillCatalogRoot } from "./skill-hook-catalog";
import type {
  SkillHookConfiguration,
  SkillHookReceipt,
} from "./skill-hook-handler";

const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_CALLS = 128;
export interface SkillTracking {
  configuration: SkillHookConfiguration;
  hooks: Record<string, unknown>;
  command: string;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Install the runner's silent observer separately from authorized plugin hooks. */
export async function prepareSkillTracking(options: {
  privateRoot: string;
  host: "codex";
  roots?: SkillCatalogRoot[];
}): Promise<SkillTracking> {
  const root = join(options.privateRoot, "skill-tracking");
  const receipts = join(root, "receipts");
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const configuration: SkillHookConfiguration = {
    host: options.host,
    receipts,
    ...(await skillHookCatalog(options.roots ?? [])),
  };
  const configurationPath = join(root, "configuration.json");
  await writeFile(configurationPath, JSON.stringify(configuration), {
    flag: "wx",
    mode: 0o600,
  });
  const command = [
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    process.execPath,
    fileURLToPath(new URL("./skill-hook-handler.ts", import.meta.url)),
    configurationPath,
  ]
    .map(quote)
    .join(" ");
  return { configuration, command, hooks: hookDefinitions(command) };
}

function hookDefinitions(command: string) {
  return Object.fromEntries(
    ["SessionStart", "PreToolUse", "PostToolUse", "Stop"].map((event) => {
      return [event, [{ hooks: [{ type: "command", command, timeout: 5 }] }]];
    }),
  );
}

function isReceipt(value: unknown): value is SkillHookReceipt {
  if (!isRecord(value)) return false;
  return (
    receiptLabels(value) &&
    stringList(value.invocations) &&
    stringList(value.ambiguousInvocations) &&
    typeof value.partial === "boolean"
  );
}

function stringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

function receiptLabels(value: Record<string, unknown>): boolean {
  if (
    !["SessionStart", "PreToolUse", "PostToolUse", "Stop"].includes(
      String(value.event),
    )
  )
    return false;
  return [value.sessionId, value.turnId, value.toolUseId, value.toolName].every(
    (field) => field === null || typeof field === "string",
  );
}

async function receipts(tracking: SkillTracking) {
  const root = tracking.configuration.receipts;
  const result = { events: [] as SkillHookReceipt[], partial: false };
  try {
    const path = join(root, "events.jsonl");
    if ((await stat(path)).size > MAX_EVENTS_BYTES)
      throw new Error("oversized skill hook receipts");
    result.partial = await Bun.file(join(root, "partial")).exists();
    for (const line of (await readFile(path, "utf8")).trimEnd().split("\n")) {
      const event: unknown = JSON.parse(line);
      if (!isReceipt(event)) throw new Error("invalid skill hook receipt");
      result.events.push(event);
    }
  } catch {
    result.partial = true;
  }
  return result;
}

function hookKey(event: SkillHookReceipt): string {
  return JSON.stringify([event.sessionId, event.toolUseId]);
}

function collectionComplete(
  events: SkillHookReceipt[],
  sessionId: string | null,
): boolean {
  if (!lifecycleAvailable(events, sessionId)) return false;
  const ledger = {
    pending: new Set<string>(),
    finished: new Set<string>(),
    partial: false,
  };
  for (const event of events) updatePending(event, ledger);
  return (
    ledger.pending.size === 0 &&
    !ledger.partial &&
    events.every((event) => !event.partial)
  );
}

function lifecycleAvailable(
  events: SkillHookReceipt[],
  sessionId: string | null,
): boolean {
  const selected = events.filter((event) => event.sessionId === sessionId);
  return (
    sessionId !== null &&
    selected.some((event) => event.event === "SessionStart") &&
    selected.some((event) => event.event === "Stop")
  );
}

function updatePending(
  event: SkillHookReceipt,
  ledger: { pending: Set<string>; finished: Set<string>; partial: boolean },
) {
  const key = hookKey(event);
  if (event.event === "PreToolUse") {
    ledger.partial ||= duplicateCall(key, ledger);
    ledger.pending.add(key);
  }
  if (event.event === "PostToolUse") {
    ledger.partial ||= !ledger.pending.delete(key);
    ledger.finished.add(key);
  }
}

function duplicateCall(
  key: string,
  ledger: { pending: Set<string>; finished: Set<string> },
): boolean {
  return ledger.pending.has(key) || ledger.finished.has(key);
}

function retainedCalls(events: SkillHookReceipt[]) {
  const calls: SkillHookReceipt[] = [];
  let truncated = false;
  for (const event of events.filter((event) => event.invocations.length > 0)) {
    calls.push(event);
    if (
      calls.length > MAX_RETAINED_CALLS ||
      Buffer.byteLength(JSON.stringify(calls)) > 24 * 1024
    ) {
      calls.pop();
      truncated = true;
      break;
    }
  }
  return { calls, truncated };
}

export async function skillTrackingObservation(
  tracking: SkillTracking,
  sessionId: string | null,
  completed: boolean,
) {
  const { events, partial } = await receipts(tracking);
  const { calls, truncated } = retainedCalls(events);
  const complete = [
    completed,
    !partial,
    !truncated,
    tracking.configuration.catalogComplete,
    collectionComplete(events, sessionId),
  ].every(Boolean);
  return {
    id: "sevro.host.skill-activations",
    completeness: complete ? ("complete" as const) : ("partial" as const),
    data: {
      method: "tool_result_body_match",
      visibility: "tool_result",
      scope: "prepared_skill_bodies",
      catalogComplete: tracking.configuration.catalogComplete,
      observedSkills: [...new Set(calls.flatMap((call) => call.invocations))],
      ambiguousSkills: [
        ...new Set(events.flatMap((event) => event.ambiguousInvocations)),
      ],
      calls,
      truncated,
    },
  };
}
