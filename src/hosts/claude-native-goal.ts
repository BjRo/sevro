import { parseClaudeEvents, type ClaudeEvents } from "../host-events/index";
import { requireRecord } from "../kernel/index";
import type { ClaudeNativeSession } from "./claude-native-session";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return requireRecord(value, "Malformed native session record");
}
function records(text: string | ClaudeEvents): RecordValue[] {
  return parseClaudeEvents(text).lines.map((line) => {
    if (!line.parsed) throw line.error;
    return record(line.value);
  });
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

function requireSuccessfulResult(
  stream: string | ClaudeEvents,
  sessionId: string,
): void {
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
  stream: string | ClaudeEvents,
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

/** Read only this trial's native session; never manufacture a goal. */
export async function observeClaudeNativeGoal(
  session: ClaudeNativeSession,
): Promise<{
  id: string;
  completeness: "complete" | "unavailable";
  data: Record<string, unknown>;
}> {
  try {
    return {
      id: "sevro.host.native-goal",
      completeness: "complete",
      data: claudeNativeGoalEvidence(
        session.final.events,
        await session.transcript(),
        session.id,
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
