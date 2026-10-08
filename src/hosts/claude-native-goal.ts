import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed native session record");
  return value as RecordValue;
}
function records(text: string): RecordValue[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => record(JSON.parse(line)));
}

function goalAttachment(event: RecordValue) {
  if (event.isSidechain === true || event.type !== "attachment") return [];
  const attachment = record(event.attachment);
  if (attachment.type !== "goal_status") return [];
  const characters = goalCharacters(attachment);
  return [
    {
      status: attachmentStatus(attachment),
      characters,
      ...(typeof event.timestamp === "string" ? { at: event.timestamp } : {}),
    },
  ];
}

function goalCharacters(attachment: RecordValue): number {
  const characters =
    typeof attachment.condition === "string"
      ? Array.from(attachment.condition).length
      : 0;
  if (!characters || characters > 4000 || typeof attachment.met !== "boolean")
    throw new Error("Malformed native goal attachment");
  return characters;
}

function attachmentStatus(attachment: RecordValue): string {
  if (attachment.failed === true) return "blocked";
  if (!attachment.met) return "active";
  return attachment.sentinel === true ? "cleared" : "complete";
}

function requireSuccessfulResult(stream: string, sessionId: string): void {
  const result = records(stream)
    .filter((event) => event.type === "result")
    .at(-1);
  if (
    !result ||
    result.session_id !== sessionId ||
    result.subtype !== "success" ||
    result.is_error !== false
  )
    throw new Error("Native session did not finish successfully");
}

/** Claude's native persisted goal attachments; sentinel clearance is not success. */
export function claudeNativeGoalEvidence(
  stream: string,
  transcript: string,
  sessionId: string,
) {
  const events = records(transcript);
  requireBoundSession(events, sessionId);
  requireSuccessfulResult(stream, sessionId);
  const goals = events.flatMap(goalAttachment);
  return {
    method: "native_session",
    threadId: sessionId,
    goals,
    goalStatus: goals.at(-1)?.status ?? null,
  };
}

function requireBoundSession(events: RecordValue[], sessionId: string): void {
  for (const event of events) {
    if (event.sessionId && event.sessionId !== sessionId)
      throw new Error("Foreign native session record");
  }
  if (!events.some((event) => event.sessionId === sessionId))
    throw new Error("Original native session not retained");
}

async function sessionPaths(
  path: string,
  sessionId: string,
  bound = { entries: 0 },
): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  bound.entries += entries.length;
  if (bound.entries > 1024)
    throw new Error("Native transcript tree exceeds limit");
  if (entries.some((entry) => entry.isSymbolicLink()))
    throw new Error("Native transcript tree contains a symlink");
  return (
    await Promise.all(
      entries.map(async (entry) =>
        entry.isDirectory()
          ? sessionPaths(join(path, entry.name), sessionId, bound)
          : basename(entry.name) === `${sessionId}.jsonl`
            ? [join(path, entry.name)]
            : [],
      ),
    )
  ).flat();
}

/** Read only this trial's original native session; never manufacture a goal. */
export async function observeClaudeNativeGoal(
  configRoot: string,
  stream: string,
): Promise<{
  id: string;
  completeness: "complete" | "unavailable";
  data: Record<string, unknown>;
}> {
  try {
    const id = originalSessionId(stream);
    const bytes = await nativeTranscript(configRoot, id);
    return {
      id: "sevro.host.native-goal",
      completeness: "complete",
      data: claudeNativeGoalEvidence(
        stream,
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        id,
      ),
    };
  } catch (error) {
    return {
      id: "sevro.host.native-goal",
      completeness: "unavailable",
      data: {
        method: "native_session",
        failure:
          error instanceof Error
            ? error.message
            : "Native observation unavailable",
      },
    };
  }
}

function originalSessionId(stream: string): string {
  const initializations = records(stream).filter(
    (event) => event.type === "system" && event.subtype === "init",
  );
  const ids = new Set(initializations.map((event) => event.session_id));
  const [id] = ids;
  if (ids.size !== 1 || typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
    throw new Error("Missing or ambiguous original Claude session");
  return id;
}

async function nativeTranscript(
  configRoot: string,
  id: string,
): Promise<Buffer> {
  const paths = await sessionPaths(join(configRoot, "projects"), id);
  const path = uniqueTranscriptPath(paths);
  const entry = await lstat(path);
  if (!entry.isFile() || entry.size > 8 * 1024 * 1024)
    throw new Error("Native transcript is unsafe or oversized");
  const bytes = await readFile(path);
  if (bytes.length > 8 * 1024 * 1024)
    throw new Error("Native transcript exceeds limit");
  return bytes;
}

function uniqueTranscriptPath(paths: string[]): string {
  const [path] = paths;
  if (paths.length !== 1 || path === undefined)
    throw new Error("Missing or ambiguous native transcript");
  return path;
}
