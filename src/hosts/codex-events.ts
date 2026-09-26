const MAX_EVENT_STREAM_BYTES = 8 * 1024 * 1024;

export class CodexEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexEventError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usage(
  value: unknown,
): { inputTokens: number; outputTokens: number } | null {
  if (!record(value)) return null;
  const input = value.input_tokens;
  const output = value.output_tokens;
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isSafeInteger(output) ||
    output < 0
  )
    return null;
  return { inputTokens: input, outputTokens: output };
}

export interface CodexEventSummary {
  threadId: string;
  complete: boolean;
  finalMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageComplete: boolean;
}

/** Parse one bounded `codex exec --json` turn. A partial stream is never success. */
export function summarizeCodexEvents(
  stream: string,
  exitCode: number,
): CodexEventSummary {
  if (Buffer.byteLength(stream, "utf8") > MAX_EVENT_STREAM_BYTES)
    throw new CodexEventError("Codex event stream exceeds 8 MiB");
  let threadId: string | null = null;
  let completed = false;
  let failed = false;
  let finalMessage: string | null = null;
  let tokenUsage: ReturnType<typeof usage> = null;
  let usageComplete = false;
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CodexEventError("Codex event stream contains invalid JSONL");
    }
    if (!record(parsed) || typeof parsed.type !== "string")
      throw new CodexEventError("Codex event stream contains an invalid event");
    if (parsed.type === "thread.started") {
      if (
        threadId !== null ||
        typeof parsed.thread_id !== "string" ||
        !parsed.thread_id
      )
        throw new CodexEventError(
          "Codex event stream has an invalid thread start",
        );
      threadId = parsed.thread_id;
    }
    if (parsed.type === "item.completed" && record(parsed.item)) {
      if (parsed.item.type === "agent_message" && !completed) {
        finalMessage =
          typeof parsed.item.text === "string" ? parsed.item.text : null;
      }
    }
    if (parsed.type === "turn.completed") {
      if (!threadId || completed || failed)
        throw new CodexEventError(
          "Codex event stream has an invalid turn completion",
        );
      completed = true;
      usageComplete = usage(parsed.usage) !== null;
      tokenUsage = usage(parsed.usage);
    }
    if (parsed.type === "turn.failed") failed = true;
  }
  if (!threadId)
    throw new CodexEventError("Codex event stream has no thread start");
  return {
    threadId,
    complete: exitCode === 0 && completed && !failed,
    finalMessage,
    inputTokens: tokenUsage?.inputTokens ?? null,
    outputTokens: tokenUsage?.outputTokens ?? null,
    usageComplete: exitCode === 0 && completed && !failed && usageComplete,
  };
}
