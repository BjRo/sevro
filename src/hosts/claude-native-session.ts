/**
 * One Claude native session: Sevro names it, runs its turns (resuming it for a
 * continuation), decides whether every turn's results are bound to it, and
 * reads its native transcript from private state at most once.
 */
import { isRecord } from "../kernel/index";
import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  summarizeClaudeEvents,
  parseClaudeEvents,
  type ClaudeEvents,
} from "../host-events/index";
import { workspaceFingerprint } from "../workspace/index";
import { MAX_EVENT_BYTES, MAX_STDERR_BYTES } from "../native-process/index";

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 1024;

export type ClaudeProcessResult = { code: number; out: string; err: string };
export type ClaudeSessionOption = {
  option: "--session-id" | "--resume";
  id: string;
};
type Observation = {
  id: string;
  completeness: "complete" | "partial";
  data: Record<string, unknown>;
};

/** One turn's raw output and its parsed event stream. */
export interface ClaudeTurn {
  code: number;
  out: string;
  err: string;
  events: ClaudeEvents;
}

export interface ClaudeNativeSession {
  /** The id Sevro named the session with. */
  id: string;
  /** Every run turn's results, and only those, belong to this session. */
  bound: boolean;
  /** The initial turn's results belong to this session. */
  initialBound: boolean;
  initial: ClaudeTurn;
  /** Present only when the continuation actually ran. */
  followUp: ClaudeTurn | null;
  /** The last turn that ran. */
  final: ClaudeTurn;
  /** All run turns as one process outcome. */
  combined: ClaudeTurn;
  continuation?: Observation;
  /** The session's native transcript; rejects with a stated reason. */
  transcript(): Promise<string>;
}

type TurnRunner = (
  prompt: string,
  session: ClaudeSessionOption,
) => Promise<ClaudeProcessResult>;

/** Run the initial turn and any continuation in one Sevro-named session. */
export async function runClaudeNativeSession(options: {
  prompt: string;
  followUpPrompt?: string;
  workspace: string;
  /** Claude's configuration root, whose `projects/` holds native transcripts. */
  configRoot: string;
  run: TurnRunner;
}): Promise<ClaudeNativeSession> {
  const id = randomUUID();
  const transcript = onceTranscript(options.configRoot, id);
  if (options.followUpPrompt === undefined) {
    const initial = parsedTurn(
      await options.run(options.prompt, { option: "--session-id", id }),
    );
    return singleTurn(initial, id, boundTurn(initial, id), transcript);
  }
  return continuedSession(
    { ...options, followUpPrompt: options.followUpPrompt },
    id,
    transcript,
  );
}

async function continuedSession(
  options: {
    prompt: string;
    followUpPrompt: string;
    workspace: string;
    run: TurnRunner;
  },
  id: string,
  transcript: () => Promise<string>,
): Promise<ClaudeNativeSession> {
  const initialFingerprint = await workspaceFingerprint(options.workspace);
  const initial = parsedTurn(
    await options.run(options.prompt, { option: "--session-id", id }),
  );
  const complete = summarizeClaudeEvents(initial.events, initial.code).complete;
  const bound = boundTurn(initial, id);
  if (!complete || !bound) {
    // An unfinished or unbound initial turn cannot be continued.
    const failed = { ...initial, code: complete ? 1 : initial.code };
    return singleTurn(failed, id, bound, transcript);
  }
  const beforeFollowUp = await workspaceFingerprint(options.workspace);
  const followUp = parsedTurn(
    await options.run(options.followUpPrompt, { option: "--resume", id }),
  );
  return combinedSession(
    { initial, followUp, id, transcript },
    initialFingerprint,
    beforeFollowUp,
  );
}

function singleTurn(
  initial: ClaudeTurn,
  id: string,
  bound: boolean,
  transcript: () => Promise<string>,
): ClaudeNativeSession {
  return {
    id,
    bound,
    initialBound: bound,
    initial,
    followUp: null,
    final: initial,
    combined: initial,
    transcript,
  };
}

function parsedTurn(result: ClaudeProcessResult): ClaudeTurn {
  return { ...result, events: parseClaudeEvents(result.out) };
}

/** Bound: fully parsed, one result, and every init and result names the session. */
function boundTurn(turn: ClaudeTurn, id: string): boolean {
  if (turn.events.lines.some((line) => !line.parsed)) return false;
  const entries = turn.events.lines
    .map((line) => (line.parsed ? line.value : null))
    .filter(isRecord);
  const results = entries.filter((entry) => entry.type === "result");
  const initializations = entries.filter(
    (entry) => entry.type === "system" && entry.subtype === "init",
  );
  return (
    results.length === 1 &&
    [...results, ...initializations].every((entry) => entry.session_id === id)
  );
}

function combinedOutput(initial: ClaudeTurn, followUp: ClaudeTurn) {
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
  id: string,
  initialFingerprint: string | null,
  beforeFollowUp: string | null,
): Observation {
  const measured = initialFingerprint !== null && beforeFollowUp !== null;
  return {
    id: "sevro.claude.continuation",
    completeness: bound && measured ? "complete" : "partial",
    data: {
      method: "same_session_resume",
      sessionId: id,
      preFollowUpWorktreeUnchanged: measured
        ? initialFingerprint === beforeFollowUp
        : null,
    },
  };
}

function combinedSession(
  turns: {
    initial: ClaudeTurn;
    followUp: ClaudeTurn;
    id: string;
    transcript: () => Promise<string>;
  },
  initialFingerprint: string | null,
  beforeFollowUp: string | null,
): ClaudeNativeSession {
  const { initial, followUp, id, transcript } = turns;
  const bound = boundTurn(followUp, id);
  const resumed =
    summarizeClaudeEvents(followUp.events, followUp.code).complete && bound;
  const { out, err } = combinedOutput(initial, followUp);
  return {
    id,
    bound,
    initialBound: true,
    initial,
    followUp,
    final: followUp,
    combined: {
      code: resumed ? 0 : followUp.code || 1,
      out,
      err,
      events: { lines: [...initial.events.lines, ...followUp.events.lines] },
    },
    continuation: continuationObservation(
      resumed,
      id,
      initialFingerprint,
      beforeFollowUp,
    ),
    transcript,
  };
}

function onceTranscript(configRoot: string, id: string) {
  let read: Promise<string> | undefined;
  return () => (read ??= nativeTranscript(configRoot, id));
}

/** Read this session's unique, bounded native transcript; never another's. */
async function nativeTranscript(configRoot: string, id: string) {
  const path = uniqueTranscriptPath(
    await sessionPaths(join(configRoot, "projects"), id),
  );
  const entry = await lstat(path);
  if (!entry.isFile() || entry.size > MAX_TRANSCRIPT_BYTES)
    throw new Error("Native transcript is unsafe or oversized");
  const bytes = await readFile(path);
  if (bytes.length > MAX_TRANSCRIPT_BYTES)
    throw new Error("Native transcript exceeds limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function uniqueTranscriptPath(paths: string[]): string {
  const [path] = paths;
  if (paths.length !== 1 || path === undefined)
    throw new Error("Missing or ambiguous native transcript");
  return path;
}

async function sessionPaths(
  path: string,
  id: string,
  bound = { entries: 0 },
): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  bound.entries += entries.length;
  if (bound.entries > MAX_TRANSCRIPT_ENTRIES)
    throw new Error("Native transcript tree exceeds limit");
  if (entries.some((entry) => entry.isSymbolicLink()))
    throw new Error("Native transcript tree contains a symlink");
  return (
    await Promise.all(
      entries.map(async (entry) =>
        entry.isDirectory()
          ? sessionPaths(join(path, entry.name), id, bound)
          : basename(entry.name) === `${id}.jsonl`
            ? [join(path, entry.name)]
            : [],
      ),
    )
  ).flat();
}
