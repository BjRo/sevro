import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shellQuote as quote } from "../shell";
import { fileURLToPath } from "node:url";
import { isRecord, isUnknownArray } from "../value-guards";
import { skillHookCatalog, type SkillCatalogRoot } from "./skill-hook-catalog";
import type {
  HookSkill,
  SkillBodyRanges,
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
    fileURLToPath(
      new URL(
        import.meta.filename.endsWith(".ts")
          ? "./skill-hook-handler.ts"
          : "./skill-hook-handler.js",
        import.meta.url,
      ),
    ),
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

function isReceipt(
  value: unknown,
  skills: HookSkill[],
): value is SkillHookReceipt {
  if (!isRecord(value)) return false;
  return (
    receiptLabels(value) &&
    stringList(value.invocations) &&
    stringList(value.ambiguousInvocations) &&
    receiptPageFields(value, skills)
  );
}

function receiptPageFields(
  value: Record<string, unknown>,
  skills: HookSkill[],
) {
  return (
    typeof value.partial === "boolean" &&
    validBodyRanges(value.bodyRanges, skills)
  );
}

function validOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validRange(value: unknown, length: number): boolean {
  if (!isOffsetRange(value)) return false;
  const [start, end] = value;
  return start < end && end <= length;
}

function isOffsetRange(value: unknown): value is [number, number] {
  return (
    isUnknownArray(value) && value.length === 2 && value.every(validOffset)
  );
}

function validPage(value: unknown, skills: HookSkill[]): boolean {
  if (!isRecord(value) || !Array.isArray(value.ranges)) return false;
  const skill = skills.find(
    (item) =>
      item.invocation === value.invocation && item.sha256 === value.sha256,
  );
  if (!skill) return false;
  return value.ranges.every((range: unknown) =>
    validRange(range, skill.body.length),
  );
}

function validBodyRanges(value: unknown, skills: HookSkill[]): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.every((page: unknown) => validPage(page, skills))
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
  const result = { events: [] as SkillHookReceipt[], reasons: [] as string[] };
  if (existsSync(join(root, "partial")))
    result.reasons.push("observer_failure");
  try {
    const path = join(root, "events.jsonl");
    if ((await stat(path)).size > MAX_EVENTS_BYTES)
      return { ...result, reasons: [...result.reasons, "receipt_limit"] };
    parseReceipts(
      await readFile(path, "utf8"),
      tracking.configuration.skills,
      result.events,
    );
  } catch (error) {
    result.reasons.push(
      error instanceof SyntaxError
        ? "invalid_receipts"
        : "receipts_unavailable",
    );
  }
  return result;
}

function parseReceipts(
  text: string,
  skills: HookSkill[],
  events: SkillHookReceipt[],
) {
  for (const line of text.trimEnd().split("\n")) {
    const event: unknown = JSON.parse(line);
    if (!isReceipt(event, skills))
      throw new SyntaxError("invalid skill hook receipt");
    events.push(event);
  }
}

function hookKey(event: SkillHookReceipt): string {
  return JSON.stringify([event.sessionId, event.toolUseId]);
}

function collectionSummary(
  events: SkillHookReceipt[],
  sessionId: string | null,
) {
  const ledger = {
    pending: new Set<string>(),
    finished: new Set<string>(),
    diagnosticKeys: new Set<string>(),
    duplicateToolCallCount: 0,
    unmatchedPostToolUseCount: 0,
  };
  for (const event of events) updatePending(event, ledger);
  return {
    diagnosticKeys: new Set([...ledger.diagnosticKeys, ...ledger.pending]),
    eventCount: events.length,
    preToolUseCount: events.filter((event) => event.event === "PreToolUse")
      .length,
    postToolUseCount: events.filter((event) => event.event === "PostToolUse")
      .length,
    pendingToolCallCount: ledger.pending.size,
    duplicateToolCallCount: ledger.duplicateToolCallCount,
    unmatchedPostToolUseCount: ledger.unmatchedPostToolUseCount,
    partialEventCount: events.filter((event) => event.partial).length,
    ...lifecycleSummary(events, sessionId),
  };
}

function lifecycleSummary(
  events: SkillHookReceipt[],
  sessionId: string | null,
) {
  const selected = events.filter((event) => event.sessionId === sessionId);
  return {
    sessionIdentified: sessionId !== null,
    sessionStarted: selected.some((event) => event.event === "SessionStart"),
    sessionStopped: selected.some((event) => event.event === "Stop"),
  };
}

function updatePending(
  event: SkillHookReceipt,
  ledger: {
    pending: Set<string>;
    finished: Set<string>;
    diagnosticKeys: Set<string>;
    duplicateToolCallCount: number;
    unmatchedPostToolUseCount: number;
  },
) {
  const key = hookKey(event);
  if (event.event === "PreToolUse") {
    if (duplicateCall(key, ledger)) {
      ledger.duplicateToolCallCount++;
      ledger.diagnosticKeys.add(key);
    }
    ledger.pending.add(key);
  }
  if (event.event === "PostToolUse") {
    if (!ledger.pending.delete(key)) {
      ledger.unmatchedPostToolUseCount++;
      ledger.diagnosticKeys.add(key);
    }
    ledger.finished.add(key);
  }
}

function duplicateCall(
  key: string,
  ledger: { pending: Set<string>; finished: Set<string> },
): boolean {
  return ledger.pending.has(key) || ledger.finished.has(key);
}

function mergedRanges(ranges: [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1])
      previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function wholeBody(ranges: [number, number][], skill: HookSkill) {
  const range = ranges[0];
  return (
    ranges.length === 1 &&
    range !== undefined &&
    range[0] === 0 &&
    range[1] === skill.body.length
  );
}

function completedPage(
  receipt: SkillHookReceipt,
  page: SkillBodyRanges,
  skills: HookSkill[],
) {
  const aliases = skills.filter((skill) => skill.sha256 === page.sha256);
  if (aliases.some((skill) => skill.invocation !== page.invocation)) {
    receipt.ambiguousInvocations = [
      ...new Set([
        ...receipt.ambiguousInvocations,
        ...aliases.map((skill) => skill.invocation),
      ]),
    ];
    receipt.partial = true;
  } else
    receipt.invocations = [
      ...new Set([...receipt.invocations, page.invocation]),
    ];
}

function accumulatePage(
  receipt: SkillHookReceipt,
  page: SkillBodyRanges,
  skills: HookSkill[],
  coverage: Map<string, [number, number][]>,
) {
  const skill = skills.find(
    (item) =>
      item.invocation === page.invocation && item.sha256 === page.sha256,
  );
  if (!skill) {
    receipt.partial = true;
    return;
  }
  const key = JSON.stringify([
    receipt.sessionId,
    receipt.turnId,
    page.invocation,
    page.sha256,
  ]);
  const ranges = mergedRanges([...(coverage.get(key) ?? []), ...page.ranges]);
  coverage.set(key, ranges);
  if (wholeBody(ranges, skill)) completedPage(receipt, page, skills);
}

function pagedEvents(events: SkillHookReceipt[], skills: HookSkill[]) {
  const coverage = new Map<string, [number, number][]>();
  const settled = new Set<string>();
  return events.map((event) => {
    const receipt = { ...event };
    for (const page of event.bodyRanges ?? []) {
      if (!settled.has(page.invocation))
        accumulatePage(receipt, page, skills, coverage);
    }
    for (const invocation of receipt.invocations) settled.add(invocation);
    return receipt;
  });
}

function publicReceipt(event: SkillHookReceipt) {
  const receipt = { ...event };
  delete receipt.bodyRanges;
  return {
    ...receipt,
    fragmentSkills: [
      ...new Set((event.bodyRanges ?? []).map((page) => page.invocation)),
    ],
  };
}

function incompleteSkills(events: SkillHookReceipt[]) {
  const settled = new Set(
    events.flatMap((event) => [
      ...event.invocations,
      ...event.ambiguousInvocations,
    ]),
  );
  const fragments = new Set(
    events.flatMap((event) =>
      (event.bodyRanges ?? []).map((page) => page.invocation),
    ),
  );
  return [...fragments].filter((invocation) => !settled.has(invocation));
}

function retainedCalls(
  events: SkillHookReceipt[],
  diagnosticKeys: Set<string>,
) {
  const calls: ReturnType<typeof publicReceipt>[] = [];
  let truncated = false;
  for (const event of events.filter((event) =>
    relevantCall(event, diagnosticKeys),
  )) {
    calls.push(publicReceipt(event));
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

function relevantCall(
  event: SkillHookReceipt,
  diagnosticKeys: Set<string>,
): boolean {
  return [
    event.invocations.length > 0,
    event.ambiguousInvocations.length > 0,
    (event.bodyRanges ?? []).length > 0,
    event.partial,
    diagnosticKeys.has(hookKey(event)),
  ].some(Boolean);
}

function primaryEvidence(events: SkillHookReceipt[], reasons: string[]) {
  const index = events.findIndex((event) => event.invocations.length > 0);
  const first = events[index];
  const complete = primarySelectionComplete(events, index, reasons);
  if (!complete)
    return { primarySkill: null, primarySkillCompleteness: "partial" as const };
  return {
    primarySkill: first?.invocations[0] ?? null,
    primarySkillCompleteness: "complete" as const,
  };
}

function primarySelectionComplete(
  events: SkillHookReceipt[],
  index: number,
  reasons: string[],
) {
  const matches = events[index]?.invocations.length ?? 0;
  if (matches > 1) return false;
  if (reasons.length === 0) return true;
  return primaryBeforeGap(events, index, reasons);
}

function primaryBeforeGap(
  events: SkillHookReceipt[],
  index: number,
  reasons: string[],
) {
  if (reasons.join(",") !== "pending_tool_calls") return false;
  if (events[index]?.invocations.length !== 1) return false;
  const prefix = collectionSummary(events.slice(0, index + 1), null);
  return prefix.pendingToolCallCount === 0;
}

export function skillActivationClaims(
  observation: Awaited<ReturnType<typeof skillTrackingObservation>>,
) {
  if (observation.completeness !== "partial") return [];
  if (observation.data.primarySkillCompleteness !== "complete") return [];
  return [
    {
      id: "sevro.host.skill-activation-claims",
      completeness: "complete" as const,
      data: {
        method: "tool_result_body_match",
        scope: "primary_and_positive_presence",
        collectionCompleteness: "partial",
        primarySkill: observation.data.primarySkill,
        presentSkills: observation.data.observedSkills,
      },
    },
  ];
}

export function skillExposureClaims(
  observation: Awaited<ReturnType<typeof skillTrackingObservation>>,
) {
  const skillExposures = observation.data.skillExposures.filter(
    (exposure) => exposure.status === "full" || exposure.status === "partial",
  );
  if (skillExposures.length === 0) return [];
  return [
    {
      id: "sevro.host.skill-exposure-claims",
      completeness: "complete" as const,
      data: {
        method: "tool_result_body_match",
        scope: "positive_exposure",
        collectionStatus: observation.data.collectionStatus,
        skillExposures,
      },
    },
  ];
}

function exposureSummary(
  skills: HookSkill[],
  events: SkillHookReceipt[],
  collectionStatus: string,
) {
  const exposure = {
    full: new Set(events.flatMap((event) => event.invocations)),
    partial: new Set(incompleteSkills(events)),
    ambiguous: new Set(events.flatMap((event) => event.ambiguousInvocations)),
  };
  return skills.map(({ invocation: skill }) => ({
    skill,
    status: skillExposureStatus(skill, exposure, collectionStatus),
  }));
}

function skillExposureStatus(
  skill: string,
  exposure: { full: Set<string>; partial: Set<string>; ambiguous: Set<string> },
  collectionStatus: string,
) {
  if (exposure.full.has(skill)) return "full" as const;
  if (exposure.ambiguous.has(skill)) return "ambiguous" as const;
  if (exposure.partial.has(skill)) return "partial" as const;
  return collectionStatus === "complete"
    ? ("none" as const)
    : ("unknown" as const);
}

function exposureCollectionStatus(reasons: string[], eventCount: number) {
  if (eventCount === 0) return "unavailable" as const;
  return reasons.some(
    (reason) =>
      !["partial_skill_bodies", "ambiguous_skill_bodies"].includes(reason),
  )
    ? ("partial" as const)
    : ("complete" as const);
}

export async function skillTrackingObservation(
  tracking: SkillTracking,
  sessionId: string | null,
  completed: boolean,
) {
  const collected = await receipts(tracking);
  const events = pagedEvents(collected.events, tracking.configuration.skills);
  const partialSkills = incompleteSkills(events);
  const { diagnosticKeys, ...collection } = collectionSummary(
    events,
    sessionId,
  );
  const { calls, truncated } = retainedCalls(events, diagnosticKeys);
  const ambiguousSkills = [
    ...new Set(events.flatMap((event) => event.ambiguousInvocations)),
  ];
  const conditions: [string, boolean][] = [
    ["host_incomplete", !completed],
    ["catalog_incomplete", !tracking.configuration.catalogComplete],
    ["session_identity_missing", !collection.sessionIdentified],
    ["session_start_missing", !collection.sessionStarted],
    ["session_stop_missing", !collection.sessionStopped],
    ["pending_tool_calls", collection.pendingToolCallCount > 0],
    ["unmatched_post_tool_use", collection.unmatchedPostToolUseCount > 0],
    ["duplicate_tool_calls", collection.duplicateToolCallCount > 0],
    [
      "partial_hook_events",
      events.some(
        (event) => event.partial && event.ambiguousInvocations.length === 0,
      ),
    ],
    ["ambiguous_skill_bodies", ambiguousSkills.length > 0],
    ["partial_skill_bodies", partialSkills.length > 0],
    ["calls_truncated", truncated],
  ];
  const incompleteReasons = [
    ...collected.reasons,
    ...conditions.filter(([, applies]) => applies).map(([reason]) => reason),
  ];
  const complete = incompleteReasons.length === 0;
  const collectionStatus = exposureCollectionStatus(
    incompleteReasons,
    events.length,
  );
  return {
    id: "sevro.host.skill-activations",
    completeness: complete ? ("complete" as const) : ("partial" as const),
    data: {
      method: "tool_result_body_match",
      visibility: "tool_result",
      scope: "prepared_skill_bodies",
      catalogComplete: tracking.configuration.catalogComplete,
      collectionStatus,
      skillExposures: exposureSummary(
        tracking.configuration.skills,
        events,
        collectionStatus,
      ),
      observedSkills: [...new Set(calls.flatMap((call) => call.invocations))],
      ...primaryEvidence(events, incompleteReasons),
      partialSkills,
      ambiguousSkills,
      calls,
      truncated,
      incompleteReasons,
      collection,
    },
  };
}
