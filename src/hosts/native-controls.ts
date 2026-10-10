import { isRecord, isUnknownArray } from "../value-guards";
import { summarizeClaudeEvents } from "./claude-events";
import type { codexNativeCallObservation } from "./codex-native-calls";

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

const MALFORMED = Symbol("malformed native control event");

function controlEvent(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return MALFORMED;
  }
}

function assistantBlocks(event: unknown): unknown[] | null | typeof MALFORMED {
  if (event === MALFORMED) return MALFORMED;
  if (!assistantEvent(event)) return null;
  const content = isRecord(event.message) ? event.message.content : null;
  return isUnknownArray(content) ? content : MALFORMED;
}

function nativeBlock(value: unknown): Entry | null {
  const types = ["text", "thinking", "redacted_thinking", "tool_use"];
  return isRecord(value) && types.includes(String(value.type)) ? value : null;
}

function toolIdentity(
  block: Entry,
  ids: Set<string>,
): { id: string; name: string } | null {
  if (!label(block.id, 128) || !label(block.name, 256) || ids.has(block.id))
    return null;
  return { id: block.id, name: block.name };
}

class ClaudeNativeControls {
  readonly calls: Call[] = [];
  readonly ids = new Set<string>();
  malformed = false;
  truncated = false;

  parse(stream: string): void {
    for (const line of stream.split("\n")) {
      if (!line.trim()) continue;
      if (!this.observeLine(line)) break;
    }
  }

  private observeLine(line: string): boolean {
    const blocks = assistantBlocks(controlEvent(line));
    if (blocks === null) return true;
    if (blocks === MALFORMED) {
      this.malformed = true;
      return true;
    }
    for (const block of blocks) if (!this.observeBlock(block)) return false;
    return true;
  }

  private observeBlock(value: unknown): boolean {
    const block = nativeBlock(value);
    if (!block) {
      this.malformed = true;
      return true;
    }
    if (block.type !== "tool_use") return true;
    const identity = toolIdentity(block, this.ids);
    if (!identity) {
      this.malformed = true;
      return true;
    }
    this.ids.add(identity.id);
    if (this.calls.length >= MAX_CALLS) {
      this.truncated = true;
      return false;
    }
    this.calls.push({
      ordinal: this.calls.length,
      namespace: "claude",
      name: identity.name,
    });
    return true;
  }
}

/** Observe all native labels without retaining arguments or interpreting policy. */
export function claudeNativeControls(
  stream: string,
  exitCode: number,
): NativeControlObservation {
  const summary = summarizeClaudeEvents(stream, exitCode);
  const controls = new ClaudeNativeControls();
  controls.parse(stream);
  return {
    id: "sevro.host.native-controls",
    completeness:
      summary.complete && !controls.malformed && !controls.truncated
        ? "complete"
        : "partial",
    data: {
      method: "native_control_calls",
      calls: controls.calls,
      acceptedAgentCount: null,
      submittedExecCalls: null,
      truncated: controls.truncated,
    },
  };
}

function assistantEvent(value: unknown): value is Entry {
  return isRecord(value) && value.type === "assistant";
}
