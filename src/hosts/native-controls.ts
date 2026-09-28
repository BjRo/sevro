import type { codexNativeCallObservation } from "./codex-native-calls";
import { summarizeClaudeEvents } from "./claude-events";

const MAX_CALLS = 128;
type Call = { ordinal: number; namespace: string; name: string };
type Entry = Record<string, unknown>;

export interface NativeControlObservation {
  id: "sevro.host.native-controls";
  completeness: "complete" | "partial" | "unavailable";
  data: {
    method: "native_control_calls";
    calls: Call[];
    acceptedAgentCount: number | null;
    submittedExecCalls: number | null;
    truncated: boolean | null;
  };
}

function record(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function label(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    /^[A-Za-z0-9_.:-]+$/.test(value)
  );
}

export function codexNativeControls(
  observation: Awaited<ReturnType<typeof codexNativeCallObservation>>,
): NativeControlObservation {
  const complete = observation.completeness === "complete";
  return {
    id: "sevro.host.native-controls",
    completeness: observation.completeness,
    data: {
      method: "native_control_calls",
      calls: observation.data.toolCalls.map(({ ordinal, namespace, name }) => ({
        ordinal,
        namespace,
        name,
      })),
      acceptedAgentCount: complete
        ? observation.data.acceptedSpawns.length
        : null,
      submittedExecCalls: complete ? observation.data.submittedExecCalls : null,
      truncated: complete ? false : null,
    },
  };
}

/** Observe all native labels without retaining arguments or interpreting policy. */
export function claudeNativeControls(
  stream: string,
  exitCode: number,
): NativeControlObservation {
  const summary = summarizeClaudeEvents(stream, exitCode);
  const calls: Call[] = [];
  const ids = new Set<string>();
  let malformed = false;
  let truncated = false;
  lines: for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (!record(event) || event.type !== "assistant") continue;
    const content = record(event.message) ? event.message.content : null;
    if (!Array.isArray(content)) {
      malformed = true;
      continue;
    }
    for (const block of content) {
      if (
        !record(block) ||
        !["text", "thinking", "redacted_thinking", "tool_use"].includes(
          String(block.type),
        )
      ) {
        malformed = true;
        continue;
      }
      if (block.type !== "tool_use") continue;
      if (
        !label(block.id, 128) ||
        !label(block.name, 256) ||
        ids.has(block.id)
      ) {
        malformed = true;
        continue;
      }
      ids.add(block.id);
      if (calls.length >= MAX_CALLS) {
        truncated = true;
        break lines;
      }
      calls.push({
        ordinal: calls.length,
        namespace: "claude",
        name: block.name,
      });
    }
  }
  return {
    id: "sevro.host.native-controls",
    completeness:
      summary.complete && !malformed && !truncated ? "complete" : "partial",
    data: {
      method: "native_control_calls",
      calls,
      acceptedAgentCount: null,
      submittedExecCalls: null,
      truncated,
    },
  };
}
