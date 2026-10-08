import { isRecord } from "../value-guards";
import { randomUUID } from "node:crypto";
import { summarizeClaudeEvents } from "./claude-events";
import { workspaceFingerprint } from "./workspace-fingerprint";

export type ClaudeProcessResult = { code: number; out: string; err: string };
export type ClaudeSession = { option: "--session-id" | "--resume"; id: string };
type Observation = {
  id: string;
  completeness: "complete" | "partial";
  data: Record<string, unknown>;
};
type ClaudeTurns = ClaudeProcessResult & {
  initialOut?: string;
  followUpOut?: string;
  continuation?: Observation;
  sessionResultsBound?: boolean;
};

function boundResult(stream: string, session: string): boolean {
  try {
    const results = stream
      .split("\n")
      .filter((line) => line.trim())
      .map((line): unknown => JSON.parse(line))
      .filter(isRecord)
      .filter((entry) => entry.type === "result");
    const [result] = results;
    return (
      results.length === 1 &&
      result !== undefined &&
      result.session_id === session
    );
  } catch {
    return false;
  }
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
  if (options.followUpPrompt === undefined) return options.run(options.prompt);
  const sessionId = randomUUID();
  const initialFingerprint = await workspaceFingerprint(options.workspace);
  const initial = await options.run(options.prompt, {
    option: "--session-id",
    id: sessionId,
  });
  const summary = summarizeClaudeEvents(initial.out, initial.code);
  const initialBound = boundResult(initial.out, sessionId);
  if (!summary.complete || !initialBound)
    return {
      ...initial,
      code: summary.complete ? 1 : initial.code,
      sessionResultsBound: initialBound,
    };
  const beforeFollowUp = await workspaceFingerprint(options.workspace);
  const followUp = await options.run(options.followUpPrompt, {
    option: "--resume",
    id: sessionId,
  });
  return combinedTurns(
    initial,
    followUp,
    sessionId,
    initialFingerprint,
    beforeFollowUp,
  );
}

function combinedOutput(
  initial: ClaudeProcessResult,
  followUp: ClaudeProcessResult,
) {
  const out = `${initial.out.trimEnd()}\n${followUp.out.trimStart()}`;
  const err = [initial.err.trimEnd(), followUp.err.trimStart()]
    .filter(Boolean)
    .join("\n");
  if (
    Buffer.byteLength(out, "utf8") > 8 * 1024 * 1024 ||
    Buffer.byteLength(err, "utf8") > 64 * 1024
  )
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
  initial: ClaudeProcessResult,
  followUp: ClaudeProcessResult,
  sessionId: string,
  initialFingerprint: string | null,
  beforeFollowUp: string | null,
): ClaudeTurns {
  const followUpSummary = summarizeClaudeEvents(followUp.out, followUp.code);
  const sessionResultsBound = boundResult(followUp.out, sessionId);
  const bound = followUpSummary.complete && sessionResultsBound;
  const { out, err } = combinedOutput(initial, followUp);
  return {
    code: bound ? 0 : followUp.code || 1,
    out,
    err,
    initialOut: initial.out,
    followUpOut: followUp.out,
    sessionResultsBound,
    continuation: continuationObservation(
      bound,
      sessionId,
      initialFingerprint,
      beforeFollowUp,
    ),
  };
}
