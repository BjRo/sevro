const MAX_EVENT_STREAM_BYTES = 8 * 1024 * 1024;

export class CodexEventError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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
  if (!nonnegativeInteger(input) || !nonnegativeInteger(output)) return null;
  return { inputTokens: input, outputTokens: output };
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

interface TurnState {
  threadId: string | null;
  completed: boolean;
  failed: boolean;
  finalMessage: string | null;
  tokenUsage: ReturnType<typeof usage>;
}

function parseEvent(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new CodexEventError("Codex event stream contains invalid JSONL", {
      cause,
    });
  }
  if (!record(parsed) || typeof parsed.type !== "string")
    throw new CodexEventError("Codex event stream contains an invalid event");
  return parsed;
}

function startThread(state: TurnState, event: Record<string, unknown>): void {
  if (
    state.threadId !== null ||
    typeof event.thread_id !== "string" ||
    !event.thread_id
  )
    throw new CodexEventError("Codex event stream has an invalid thread start");
  state.threadId = event.thread_id;
}

function completeTurn(state: TurnState, event: Record<string, unknown>): void {
  if (!state.threadId || state.completed || state.failed)
    throw new CodexEventError(
      "Codex event stream has an invalid turn completion",
    );
  state.completed = true;
  state.tokenUsage = usage(event.usage);
}

function completeItem(state: TurnState, item: unknown): void {
  if (!record(item) || item.type !== "agent_message" || state.completed) return;
  state.finalMessage = typeof item.text === "string" ? item.text : null;
}

function applyEvent(state: TurnState, event: Record<string, unknown>): void {
  switch (event.type) {
    case "thread.started":
      startThread(state, event);
      break;
    case "item.completed":
      completeItem(state, event.item);
      break;
    case "turn.completed":
      completeTurn(state, event);
      break;
    case "turn.failed":
      state.failed = true;
      break;
  }
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
  const state: TurnState = {
    threadId: null,
    completed: false,
    failed: false,
    finalMessage: null,
    tokenUsage: null,
  };
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    applyEvent(state, parseEvent(line));
  }
  return summarizeTurn(state, exitCode);
}

function summarizeTurn(state: TurnState, exitCode: number): CodexEventSummary {
  const { threadId, completed, failed, finalMessage, tokenUsage } = state;
  if (!threadId)
    throw new CodexEventError("Codex event stream has no thread start");
  const complete = exitCode === 0 && completed && !failed;
  return {
    threadId,
    complete,
    finalMessage,
    ...summarizeUsage(tokenUsage, complete),
  };
}

function summarizeUsage(
  tokenUsage: ReturnType<typeof usage>,
  complete: boolean,
) {
  if (tokenUsage === null)
    return { inputTokens: null, outputTokens: null, usageComplete: false };
  return { ...tokenUsage, usageComplete: complete };
}
