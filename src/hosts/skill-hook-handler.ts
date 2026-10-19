import { randomUUID } from "node:crypto";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../value-guards";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

export interface HookSkill {
  invocation: string;
  sha256: string;
  body: string;
}
export interface SkillHookConfiguration {
  host: "codex";
  receipts: string;
  skills: HookSkill[];
  catalogComplete: boolean;
}
export interface SkillHookReceipt {
  event: string;
  sessionId: string | null;
  turnId: string | null;
  toolUseId: string | null;
  toolName: string | null;
  invocations: string[];
  ambiguousInvocations: string[];
  bodyRanges?: SkillBodyRanges[];
  partial: boolean;
}
export interface SkillBodyRanges {
  invocation: string;
  sha256: string;
  ranges: [number, number][];
}

const MIN_PAGE_CHARACTERS = 32;
interface MatchBudget {
  comparisons: number;
  anchors: number;
}

function spend(budget: MatchBudget, count: number) {
  budget.comparisons -= count;
  if (budget.comparisons < 0)
    throw new Error("skill page matching exceeds limit");
}

function spendAnchor(budget: MatchBudget) {
  budget.anchors--;
  if (budget.anchors < 0) throw new Error("skill page anchors exceed limit");
}

function matchingLength(
  body: string,
  text: string,
  bodyStart: number,
  textStart: number,
  direction: number,
  budget: MatchBudget,
): number {
  const available =
    direction === 1
      ? Math.min(body.length - bodyStart, text.length - textStart)
      : Math.min(bodyStart + 1, textStart + 1);
  for (let length = 0; length < available; length++) {
    spend(budget, 1);
    if (
      body[bodyStart + direction * length] !==
      text[textStart + direction * length]
    )
      return length;
  }
  return available;
}

function lineOffsets(body: string) {
  const offsets = new Map<string, number[]>();
  for (const line of body.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0].trim()) continue;
    const positions = offsets.get(line[0]) ?? [];
    positions.push(line.index);
    offsets.set(line[0], positions);
  }
  return offsets;
}

function anchoredRange(
  body: string,
  text: string,
  bodyStart: number,
  textStart: number,
  anchorLength: number,
  budget: MatchBudget,
) {
  spendAnchor(budget);
  const before = matchingLength(
    body,
    text,
    bodyStart - 1,
    textStart - 1,
    -1,
    budget,
  );
  const after = matchingLength(
    body,
    text,
    bodyStart + anchorLength,
    textStart + anchorLength,
    1,
    budget,
  );
  return {
    start: bodyStart - before,
    end: bodyStart + anchorLength + after,
    outputEnd: textStart + anchorLength + after,
  };
}

function uniqueRange(
  body: string,
  start: number,
  end: number,
  budget: MatchBudget,
) {
  spend(budget, body.length * 2);
  const fragment = body.slice(start, end);
  return (
    body.indexOf(fragment) === start && body.indexOf(fragment, start + 1) === -1
  );
}

function lineRanges(
  body: string,
  text: string,
  line: RegExpExecArray,
  positions: number[],
  budget: MatchBudget,
) {
  const result = {
    found: false,
    ranges: [] as [number, number][],
    matchedUntil: 0,
  };
  for (const offset of positions) {
    const range = anchoredRange(
      body,
      text,
      offset,
      line.index,
      line[0].length,
      budget,
    );
    if (range.end - range.start < MIN_PAGE_CHARACTERS) continue;
    result.found = true;
    if (uniqueRange(body, range.start, range.end, budget))
      result.ranges.push([range.start, range.end]);
    result.matchedUntil = Math.max(result.matchedUntil, range.outputEnd);
  }
  return result;
}

function textRanges(body: string, text: string, budget: MatchBudget) {
  const offsets = lineOffsets(body);
  const result = { found: false, ranges: [] as [number, number][] };
  let matchedUntil = 0;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (line.index < matchedUntil) continue;
    const match = lineRanges(
      body,
      text,
      line,
      offsets.get(line[0]) ?? [],
      budget,
    );
    result.found ||= match.found;
    result.ranges.push(...match.ranges);
    matchedUntil = Math.max(matchedUntil, match.matchedUntil);
  }
  return result;
}

function skillRanges(
  skill: HookSkill,
  texts: string[],
  budget: MatchBudget,
): SkillBodyRanges[] {
  const matches = texts.map((text) => textRanges(skill.body, text, budget));
  if (!matches.some((match) => match.found)) return [];
  return [
    {
      invocation: skill.invocation,
      sha256: skill.sha256,
      ranges: matches.flatMap((match) => match.ranges),
    },
  ];
}

function label(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)
    ? value
    : null;
}

function responseTexts(value: unknown, depth = 0): string[] {
  if (depth > 16) throw new Error("skill hook response nesting exceeds limit");
  if (typeof value === "string") return [value];
  return responseValues(value).flatMap((child) =>
    responseTexts(child, depth + 1),
  );
}

function responseValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isRecord(value) ? Object.values(value) : [];
}

function completeBodyRanges(
  text: string,
  skill: HookSkill,
  budget: MatchBudget,
): [number, number][] {
  spend(budget, text.length);
  const ranges: [number, number][] = [];
  let start = text.indexOf(skill.body);
  while (start !== -1) {
    spendAnchor(budget);
    ranges.push([start, start + skill.body.length]);
    start = text.indexOf(skill.body, start + 1);
  }
  return ranges;
}

function textOutsideRanges(text: string, ranges: [number, number][]) {
  const remaining: string[] = [];
  let cursor = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    if (start > cursor) remaining.push(text.slice(cursor, start));
    cursor = Math.max(cursor, end);
  }
  remaining.push(text.slice(cursor));
  return remaining;
}

function textsOutsideCompleteBodies(
  texts: string[],
  skills: HookSkill[],
  budget: MatchBudget,
) {
  return texts.flatMap((text) =>
    textOutsideRanges(
      text,
      skills.flatMap((skill) => completeBodyRanges(text, skill, budget)),
    ),
  );
}

function invocations(
  event: Record<string, unknown>,
  configuration: SkillHookConfiguration,
): {
  invocations: string[];
  ambiguousInvocations: string[];
  bodyRanges?: SkillBodyRanges[];
} {
  if (event.hook_event_name !== "PostToolUse")
    return { invocations: [], ambiguousInvocations: [] };
  const texts = responseTexts(event.tool_response);
  const matched = configuration.skills.filter((skill) =>
    texts.some((text) => text.includes(skill.body)),
  );
  const ambiguous = matched.filter((skill) =>
    matched.some(
      (other) =>
        other.sha256 === skill.sha256 && other.invocation !== skill.invocation,
    ),
  );
  const ambiguousNames = new Set(ambiguous.map((skill) => skill.invocation));
  const unambiguous = matched.filter(
    (skill) => !ambiguousNames.has(skill.invocation),
  );
  const budget = { comparisons: 4 * MAX_INPUT_BYTES, anchors: 4096 };
  const remainingTexts = textsOutsideCompleteBodies(texts, unambiguous, budget);
  const bodyRanges = configuration.skills
    .filter((skill) => !matched.includes(skill))
    .flatMap((skill) => skillRanges(skill, remainingTexts, budget));
  return {
    invocations: [...new Set(unambiguous.map((skill) => skill.invocation))],
    ambiguousInvocations: [...ambiguousNames],
    ...(bodyRanges.length ? { bodyRanges } : {}),
  };
}

export function skillHookReceipt(
  input: unknown,
  configuration: SkillHookConfiguration,
): SkillHookReceipt {
  if (!isRecord(input) || typeof input.hook_event_name !== "string")
    throw new Error("invalid skill hook input");
  const receipt = {
    event: input.hook_event_name,
    sessionId: label(input.session_id),
    turnId: label(input.turn_id),
    toolUseId: label(input.tool_use_id),
    toolName: label(input.tool_name),
    ...invocations(input, configuration),
    partial: false,
  };
  receipt.partial =
    !validReceiptIdentity(receipt) || receipt.ambiguousInvocations.length > 0;
  return receipt;
}

function validReceiptIdentity(receipt: SkillHookReceipt): boolean {
  if (!receipt.sessionId) return false;
  return (
    !receipt.event.includes("ToolUse") ||
    (receipt.toolUseId !== null && receipt.toolName !== null)
  );
}

async function boundedInput(): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of Bun.stdin.stream()) {
    bytes += chunk.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error("skill hook input too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function appendReceipt(root: string, receipt: SkillHookReceipt) {
  const path = join(root, "events.jsonl");
  const size = await stat(path).then(
    (file) => file.size,
    () => 0,
  );
  if (size > MAX_RECEIPT_BYTES) {
    await writeFile(join(root, "partial"), "limit\n", { mode: 0o600 });
    return;
  }
  const file = await open(path, "a", 0o600);
  try {
    await file.write(JSON.stringify(receipt) + "\n");
  } finally {
    await file.close();
  }
}

/** A silent observer: errors affect evidence availability, never tool decisions. */
export async function runSkillHook(configurationPath: string): Promise<void> {
  const configuration = JSON.parse(
    await readFile(configurationPath, "utf8"),
  ) as SkillHookConfiguration;
  try {
    await appendReceipt(
      configuration.receipts,
      skillHookReceipt(await boundedInput(), configuration),
    );
  } catch {
    await writeFile(join(configuration.receipts, "partial"), randomUUID(), {
      mode: 0o600,
    });
  }
}

if (import.meta.main) {
  try {
    await runSkillHook(process.argv[2] ?? "");
  } catch {
    // Missing receipts remain unavailable; hook failures never alter the task.
  }
}
