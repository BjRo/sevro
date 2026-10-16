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
  partial: boolean;
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

function invocations(
  event: Record<string, unknown>,
  configuration: SkillHookConfiguration,
): { invocations: string[]; ambiguousInvocations: string[] } {
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
  return {
    invocations: [
      ...new Set(
        matched
          .filter((skill) => !ambiguousNames.has(skill.invocation))
          .map((skill) => skill.invocation),
      ),
    ],
    ambiguousInvocations: [...ambiguousNames],
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
