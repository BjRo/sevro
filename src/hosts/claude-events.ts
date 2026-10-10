import { isRecord } from "../value-guards";
const MAX_EVENT_STREAM_BYTES = 8 * 1024 * 1024;

export class ClaudeEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeEventError";
  }
}

type Entry = Record<string, unknown>;

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validAssistant(value: Entry): boolean {
  if (!isRecord(value.message) || !Array.isArray(value.message.content))
    return false;
  return value.message.content.every(validAssistantBlock);
}

function validAssistantBlock(block: unknown): boolean {
  if (!isRecord(block)) return false;
  if (block.type !== "tool_use" || block.name !== "Skill") return true;
  return validSkillInput(block.input);
}

function validSkillInput(input: unknown): boolean {
  if (!isRecord(input) || typeof input.skill !== "string") return false;
  return !!input.skill.split(":").at(-1)?.trim();
}

function validResult(value: Entry): boolean {
  return (
    typeof value.subtype === "string" &&
    !!value.subtype.trim() &&
    typeof value.is_error === "boolean" &&
    typeof value.result === "string"
  );
}

function validEvent(value: unknown): value is Entry {
  if (!isRecord(value)) return false;
  if (value.type === "result") return validResult(value);
  if (value.type === "assistant") return validAssistant(value);
  return typeof value.type === "string";
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

function usage(value: unknown): Usage | null {
  if (!isRecord(value)) return null;
  const inputTokens = inputUsage(value);
  if (inputTokens === null || !nonnegative(value.output_tokens)) return null;
  return { inputTokens, outputTokens: value.output_tokens };
}

function inputUsage(value: Entry): number | null {
  const counts = [
    value.input_tokens,
    value.cache_creation_input_tokens ?? 0,
    value.cache_read_input_tokens ?? 0,
  ];
  if (!counts.every(nonnegative)) return null;
  return counts.reduce((total, count) => total + count);
}

export interface ClaudeEventSummary {
  complete: boolean;
  finalMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  usageComplete: boolean;
}

/** Parse bounded Claude stream JSON without retaining its private event bodies. */
export function summarizeClaudeEvents(
  stream: string,
  exitCode: number,
): ClaudeEventSummary {
  if (Buffer.byteLength(stream, "utf8") > MAX_EVENT_STREAM_BYTES)
    throw new ClaudeEventError("Claude event stream exceeds 8 MiB");
  const { results, malformed } = parseResultEvents(stream);
  return resultSummary(results, malformed, exitCode);
}

function parseResultEvents(stream: string) {
  const results: Entry[] = [];
  let malformed = false;
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = parseValidEvent(line);
      if (event.type === "result") results.push(event);
    } catch {
      malformed = true;
    }
  }
  return { results, malformed };
}

function parseValidEvent(line: string): Entry {
  const event: unknown = JSON.parse(line);
  if (!validEvent(event)) throw new ClaudeEventError("Malformed Claude event");
  return event;
}

function summarizeUsage(results: Entry[], malformed: boolean) {
  const usages = results.map((result) => usage(result.usage));
  const validUsages = usages.filter((value): value is Usage => value !== null);
  const usageComplete =
    !malformed && results.length > 0 && validUsages.length === usages.length;
  return {
    inputTokens: usageComplete
      ? validUsages.reduce((total, value) => total + value.inputTokens, 0)
      : null,
    outputTokens: usageComplete
      ? validUsages.reduce((total, value) => total + value.outputTokens, 0)
      : null,
    usageComplete,
  };
}

function measuredCost(results: Entry[], malformed: boolean): number | null {
  const costs = results.map((result) => result.total_cost_usd);
  if (malformed || results.length === 0 || !costs.every(nonnegative))
    return null;
  return costs.reduce((total, value) => total + value, 0);
}

function resultSummary(
  results: Entry[],
  malformed: boolean,
  exitCode: number,
): ClaudeEventSummary {
  const final = results.at(-1);
  return {
    complete: completedResults(results, malformed, exitCode),
    finalMessage: typeof final?.result === "string" ? final.result : null,
    costUsd: measuredCost(results, malformed),
    ...summarizeUsage(results, malformed),
  };
}

function completedResults(
  results: Entry[],
  malformed: boolean,
  exitCode: number,
): boolean {
  return (
    !malformed &&
    exitCode === 0 &&
    results.length > 0 &&
    results.every(
      (result) => result.subtype === "success" && result.is_error === false,
    )
  );
}
