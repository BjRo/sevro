const MAX_EVENT_STREAM_BYTES = 8 * 1024 * 1024;

export class ClaudeEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeEventError";
  }
}

type Entry = Record<string, unknown>;

function record(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validAssistant(value: Entry): boolean {
  if (!record(value.message) || !Array.isArray(value.message.content))
    return false;
  return value.message.content.every((block: unknown) => {
    if (!record(block)) return false;
    if (block.type !== "tool_use" || block.name !== "Skill") return true;
    return (
      record(block.input) &&
      typeof block.input.skill === "string" &&
      !!block.input.skill.split(":").at(-1)?.trim()
    );
  });
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
  if (!record(value)) return false;
  if (value.type === "result") return validResult(value);
  if (value.type === "assistant") return validAssistant(value);
  return typeof value.type === "string";
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

function usage(value: unknown): Usage | null {
  if (!record(value)) return null;
  const input = value.input_tokens;
  const output = value.output_tokens;
  const cacheCreation = value.cache_creation_input_tokens ?? 0;
  const cacheRead = value.cache_read_input_tokens ?? 0;
  if (
    !nonnegative(input) ||
    !nonnegative(output) ||
    !nonnegative(cacheCreation) ||
    !nonnegative(cacheRead)
  )
    return null;
  return {
    inputTokens: input + cacheCreation + cacheRead,
    outputTokens: output,
  };
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
  const results: Entry[] = [];
  let malformed = false;
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (!validEvent(event)) malformed = true;
      else if (event.type === "result") results.push(event);
    } catch {
      malformed = true;
    }
  }
  const final = results.at(-1);
  const usages = results.map((result) => usage(result.usage));
  const usageComplete =
    !malformed && results.length > 0 && usages.every(Boolean);
  const costs = results.map((result) => result.total_cost_usd);
  return {
    complete:
      !malformed &&
      exitCode === 0 &&
      results.length > 0 &&
      results.every(
        (result) => result.subtype === "success" && result.is_error === false,
      ),
    finalMessage: typeof final?.result === "string" ? final.result : null,
    inputTokens: usageComplete
      ? usages.reduce((total, value) => total + value!.inputTokens, 0)
      : null,
    outputTokens: usageComplete
      ? usages.reduce((total, value) => total + value!.outputTokens, 0)
      : null,
    costUsd:
      !malformed && results.length && costs.every(nonnegative)
        ? costs.reduce((total, value) => total + (value as number), 0)
        : null,
    usageComplete,
  };
}
