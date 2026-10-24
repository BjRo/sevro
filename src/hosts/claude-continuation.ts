import { isRecord } from "../value-guards";
import { randomUUID } from "node:crypto";
import {
  summarizeClaudeEvents,
  parseClaudeEvents,
  type ClaudeEvents,
} from "./claude-events";
import { workspaceFingerprint } from "./workspace-fingerprint";
import { MAX_EVENT_BYTES, MAX_STDERR_BYTES } from "./process-lifecycle";

export type ClaudeProcessResult = { code: number; out: string; err: string };
export type ClaudeSession = { option: "--session-id" | "--resume"; id: string };
type Observation = {
  id: string;
  completeness: "complete" | "partial";
  data: Record<string, unknown>;
};
type ClaudeTurns = ClaudeProcessResult & {
  events: ClaudeEvents;
  initialEvents?: ClaudeEvents;
  followUpEvents?: ClaudeEvents;
  initialOut?: string;
  followUpOut?: string;
  continuation?: Observation;
  sessionResultsBound?: boolean;
};

function boundResult(stream: ClaudeEvents, session: string): boolean {
  if (stream.lines.some((line) => !line.parsed)) return false;
  const results = stream.lines
    .filter((line) => line.parsed)
    .map((line) => line.value)
    .filter(isRecord)
    .filter((entry) => entry.type === "result");
  const [result] = results;
  return (
    results.length === 1 &&
    result !== undefined &&
    result.session_id === session
  );
}

function parsedTurn(result: ClaudeProcessResult) {
  return { ...result, events: parseClaudeEvents(result.out) };
}

/** Resume a declared follow-up in the same isolated native Claude session. */
export async function runClaudeTurns(options: {
  prompt: string;
  followUpPrompt?: string;
  workspace: string;
  run: (
    prompt: string,
    session?: ClaudeSession,
  ) => Promise<ClaudeProcessResult>;
}): Promise<ClaudeTurns> {
  if (options.followUpPrompt === undefined)
    return parsedTurn(await options.run(options.prompt));
  const sessionId = randomUUID();
  const initialFingerprint = await workspaceFingerprint(options.workspace);
  const initial = parsedTurn(
    await options.run(options.prompt, {
      option: "--session-id",
      id: sessionId,
    }),
  );
  const summary = summarizeClaudeEvents(initial.events, initial.code);
  const initialBound = boundResult(initial.events, sessionId);
  if (!summary.complete || !initialBound)
    return {
      ...initial,
      code: summary.complete ? 1 : initial.code,
      sessionResultsBound: initialBound,
    };
  const beforeFollowUp = await workspaceFingerprint(options.workspace);
  const followUp = parsedTurn(
    await options.run(options.followUpPrompt, {
      option: "--resume",
      id: sessionId,
    }),
  );
  return combinedTurns(
    initial,
    followUp,
    sessionId,
    initialFingerprint,
    beforeFollowUp,
  );
}

function combinedOutput(
  initial: ReturnType<typeof parsedTurn>,
  followUp: ReturnType<typeof parsedTurn>,
) {
  const out = `${initial.out.trimEnd()}\n${followUp.out.trimStart()}`;
  const stderr = [initial.err.trimEnd(), followUp.err.trimStart()]
    .filter(Boolean)
    .join("\n");
  const err = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    Buffer.from(stderr, "utf8").subarray(0, MAX_STDERR_BYTES),
    { stream: true },
  );
  if (Buffer.byteLength(out, "utf8") > MAX_EVENT_BYTES)
    throw new Error("Claude combined process output exceeds its limit");
  return { out, err };
}

function continuationObservation(
  bound: boolean,
  sessionId: string,
  initialFingerprint: string | null,
  beforeFollowUp: string | null,
): Observation {
  const measured = initialFingerprint !== null && beforeFollowUp !== null;
  return {
    id: "sevro.claude.continuation",
    completeness: bound && measured ? "complete" : "partial",
    data: {
      method: "same_session_resume",
      sessionId,
      preFollowUpWorktreeUnchanged: measured
        ? initialFingerprint === beforeFollowUp
        : null,
    },
  };
}

function combinedTurns(
  initial: ReturnType<typeof parsedTurn>,
  followUp: ReturnType<typeof parsedTurn>,
  sessionId: string,
  initialFingerprint: string | null,
  beforeFollowUp: string | null,
): ClaudeTurns {
  const followUpSummary = summarizeClaudeEvents(followUp.events, followUp.code);
  const sessionResultsBound = boundResult(followUp.events, sessionId);
  const bound = followUpSummary.complete && sessionResultsBound;
  const { out, err } = combinedOutput(initial, followUp);
  return {
    code: bound ? 0 : followUp.code || 1,
    out,
    err,
    initialOut: initial.out,
    followUpOut: followUp.out,
    events: { lines: [...initial.events.lines, ...followUp.events.lines] },
    initialEvents: initial.events,
    followUpEvents: followUp.events,
    sessionResultsBound,
    continuation: continuationObservation(
      bound,
      sessionId,
      initialFingerprint,
      beforeFollowUp,
    ),
  };
}
