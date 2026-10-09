import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, isUnknownArray } from "../value-guards";
import {
  literalExecutorCommand,
  type LiteralExecutorCommand,
} from "./codex-executor-command";

interface NativeEntry {
  ordinal: number;
  payload: Record<string, unknown>;
}

interface YieldedChunk {
  process: string;
  id: string;
  output: string;
}

export interface RecoveredCommandOutput {
  output: string;
  chunks: number;
  completedCall?: boolean;
  literalCommandCall?: boolean;
}

function processId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return /^(?:[1-9][0-9]*)$/.test(String(value)) ? String(value) : undefined;
}

function validChunkId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,64}$/.test(value);
}
function validWallTime(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function yieldedEnvelope(value: Record<string, unknown>) {
  const process = processId(value.session_id);
  if (!process || value.exit_code != null || typeof value.output !== "string")
    return undefined;
  return { process, output: value.output };
}
function yieldedChunk(
  value: Record<string, unknown>,
): YieldedChunk | undefined {
  const envelope = yieldedEnvelope(value);
  if (!envelope) return undefined;
  if (!validChunkId(value.chunk_id) || !validWallTime(value.wall_time_seconds))
    return undefined;
  return { ...envelope, id: value.chunk_id };
}
// Decode only host result/content envelopes, never arbitrary object properties,
// prose containing JSON, or JSON printed inside a command's output.

function resultChunks(value: unknown, depth = 0): YieldedChunk[] {
  if (depth > 6) return [];
  if (typeof value === "string") return decodedChunks(value, depth);
  return containerChunks(value, depth);
}
function decodedChunks(value: string, depth: number): YieldedChunk[] {
  try {
    return resultChunks(JSON.parse(value), depth + 1);
  } catch {
    return [];
  }
}
function textEnvelope(value: unknown): boolean {
  return value === "input_text" || value === "text";
}
function containerChunks(value: unknown, depth: number): YieldedChunk[] {
  if (Array.isArray(value))
    return value.flatMap((part: unknown) => resultChunks(part, depth + 1));
  if (!isRecord(value)) return [];
  if (textEnvelope(value.type)) return resultChunks(value.text, depth + 1);
  const chunk = yieldedChunk(value);
  return chunk ? [chunk] : [];
}

function execCall(payload: Record<string, unknown>): boolean {
  if (!executorCallType(payload.type)) return false;
  const namespace = payload.namespace;
  if (namespace !== undefined && namespace !== "functions") return false;
  const names = [
    "exec",
    "exec_command",
    "write_stdin",
    "functions.exec",
    "functions.exec_command",
    "functions.write_stdin",
  ];
  return typeof payload.name === "string" && names.includes(payload.name);
}

function chunksAtEntry(
  entry: NativeEntry,
  entries: NativeEntry[],
): YieldedChunk[] {
  const { payload, ordinal } = entry;
  if (!executorOutputType(payload.type)) return [];
  if (typeof payload.call_id !== "string") return [];
  const calls = entries.filter(
    (other) =>
      execCall(other.payload) && other.payload.call_id === payload.call_id,
  );
  if (!soleEarlierCall(calls, ordinal)) return [];
  return resultChunks(payload.output);
}

function commandProcess(entry: NativeEntry): string | undefined {
  const { payload } = entry;
  if (payload.type !== "item_completed" || !isRecord(payload.item))
    return undefined;
  if (
    payload.item.type !== "CommandExecution" ||
    payload.item.source !== "unified_exec_startup"
  )
    return undefined;
  return processId(payload.item.process_id);
}

function executorEnvelope(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const decoded: unknown = JSON.parse(value);
    return decoded;
  } catch {
    return undefined;
  }
}
function executorTextBlock(block: unknown): string | undefined {
  if (
    !isRecord(block) ||
    !["input_text", "text"].includes(String(block.type)) ||
    typeof block.text !== "string"
  )
    return undefined;
  return block.text;
}
function executorTextBlocks(value: unknown): string[] | undefined {
  const envelope = executorEnvelope(value);
  if (!Array.isArray(envelope) || envelope.length < 2) return undefined;
  const text: string[] = [];
  for (const block of envelope) {
    const line = executorTextBlock(block);
    if (line === undefined) return undefined;
    text.push(line);
  }
  return text;
}

function structuredExecResult(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && ("output" in value || "session_id" in value);
  } catch {
    return false;
  }
}

function completedText(value: unknown): string | undefined {
  const text = executorTextBlocks(value);
  if (!text) return undefined;
  if (
    !/^Script completed\nWall time [0-9]+(?:\.[0-9]+)? seconds\nOutput:\n$/.test(
      text.slice(0, 1).join(""),
    )
  )
    return undefined;
  const content = text.slice(1);
  // Structured exec chunks keep their process-identity rules above. Do not
  // reinterpret a late yielded chunk as a plain completed-call result.
  return content.some(structuredExecResult) ? undefined : content.join("\n");
}

function uniqueExecutorCall(
  result: NativeEntry,
  results: NativeEntry[],
  entries: NativeEntry[],
): NativeEntry | undefined {
  const id = result.payload.call_id;
  if (
    typeof id !== "string" ||
    results.filter((other) => other.payload.call_id === id).length !== 1
  )
    return undefined;
  const calls = entries.filter(
    (entry) => execCall(entry.payload) && entry.payload.call_id === id,
  );
  return soleEarlierCall(calls, result.ordinal);
}

function uniqueCommandIdentity(
  command: NativeEntry,
  entries: NativeEntry[],
): boolean {
  const process = commandProcess(command);
  if (
    !process ||
    entries.filter((entry) => commandProcess(entry) === process).length !== 1
  )
    return false;
  const item = command.payload.item as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    entries.filter(
      ({ payload }) =>
        payload.type === "item_completed" &&
        isRecord(payload.item) &&
        payload.item.id === item.id,
    ).length === 1
  );
}

function soleCompletedCommand(
  call: NativeEntry,
  result: NativeEntry,
  entries: NativeEntry[],
): NativeEntry | undefined {
  const between = entries.filter(
    (entry) => entry.ordinal > call.ordinal && entry.ordinal < result.ordinal,
  );
  if (
    between.some(({ payload }) =>
      ["custom_tool_call", "function_call"].includes(String(payload.type)),
    )
  )
    return undefined;
  const commands = between.filter(
    ({ payload }) =>
      payload.type === "item_completed" &&
      isRecord(payload.item) &&
      payload.item.type === "CommandExecution",
  );
  return soleUniqueCommand(commands, entries);
}

function completedCallOutputs(entries: NativeEntry[]): Map<number, string> {
  const outputs = new Map<number, string>();
  const results = entries.filter(({ payload }) =>
    executorOutputType(payload.type),
  );
  for (const result of results) {
    const output = completedResultOutput(result, results, entries);
    if (output) outputs.set(output.ordinal, output.output);
  }
  return outputs;
}
function completedResultOutput(
  result: NativeEntry,
  results: NativeEntry[],
  entries: NativeEntry[],
) {
  const call = uniqueExecutorCall(result, results, entries);
  if (!call) return undefined;
  const command = soleCompletedCommand(call, result, entries);
  if (!command) return undefined;
  const item = command.payload.item as Record<string, unknown>;
  const literal = literalCallCommand(call.payload);
  if (!literal || !literalCommandMatches(item, literal)) return undefined;
  return unaggregatedCompletedOutput(command, item, result);
}
function unaggregatedCompletedOutput(
  command: NativeEntry,
  item: Record<string, unknown>,
  result: NativeEntry,
) {
  const output = completedText(result.payload.output);
  if (output === undefined) return undefined;
  if (
    typeof item.aggregated_output === "string" &&
    item.aggregated_output.includes(output)
  )
    return undefined;
  return { ordinal: command.ordinal, output };
}

function literalArgv(argv: unknown, command: LiteralExecutorCommand): boolean {
  if (!isUnknownArray(argv) || argv.length !== 3) return false;
  const [shell, flag, script]: unknown[] = argv;
  return (
    shellFlag(flag) &&
    script === command.command &&
    requestedShell(shell, command.shell)
  );
}
function shellFlag(flag: unknown): boolean {
  return typeof flag === "string" && ["-c", "-lc"].includes(flag);
}
function requestedShell(
  shell: unknown,
  requested: string | undefined,
): boolean {
  return requested === undefined || shell === requested;
}
function literalCommandMatches(
  item: Record<string, unknown>,
  command: LiteralExecutorCommand,
): boolean {
  if (!literalArgv(item.command, command)) return false;
  if (command.cwd === undefined) return true;
  return matchingCwd(item.cwd, command.cwd);
}

function normalizedCwd(observed: string): string | undefined {
  try {
    const cwd = observed.startsWith("file:")
      ? fileURLToPath(observed)
      : observed;
    return isAbsolute(cwd) ? normalize(cwd) : undefined;
  } catch {
    return undefined;
  }
}
function matchingCwd(observed: unknown, requested: string): boolean {
  if (!isAbsolute(requested) || typeof observed !== "string") return false;
  return normalizedCwd(observed) === normalize(requested);
}

function literalCallOutputs(entries: NativeEntry[]): Map<number, string> {
  const outputs = new Map<number, string>();
  const results = entries.filter(({ payload }) =>
    executorOutputType(payload.type),
  );
  for (const result of results) {
    const output = literalResultOutput(result, results, entries);
    if (output) outputs.set(output.ordinal, output.output);
  }
  return outputs;
}
function literalResultOutput(
  result: NativeEntry,
  results: NativeEntry[],
  entries: NativeEntry[],
) {
  const output = completedText(result.payload.output);
  if (output === undefined) return undefined;
  const call = uniqueExecutorCall(result, results, entries);
  if (!call) return undefined;
  const command = literalCallCommand(call.payload);
  if (!command) return undefined;
  const completion = literalCompletion(result, command, entries);
  return completion ? { ordinal: completion.ordinal, output } : undefined;
}
function literalCompletion(
  result: NativeEntry,
  command: LiteralExecutorCommand,
  entries: NativeEntry[],
) {
  const matches = entries.filter(
    (entry) =>
      commandProcess(entry) &&
      literalCommandMatches(
        entry.payload.item as Record<string, unknown>,
        command,
      ),
  );
  const completion = uniqueLaterCommand(matches, result, entries);
  if (!completion || !uniqueLiteralInvocation(command, entries))
    return undefined;
  return completion;
}
function uniqueLaterCommand(
  matches: NativeEntry[],
  result: NativeEntry,
  entries: NativeEntry[],
) {
  const [completion] = matches;
  if (matches.length !== 1 || completion === undefined) return undefined;
  if (
    completion.ordinal <= result.ordinal ||
    !uniqueCommandIdentity(completion, entries)
  )
    return undefined;
  return completion;
}
function uniqueLiteralInvocation(
  command: LiteralExecutorCommand,
  entries: NativeEntry[],
): boolean {
  return (
    entries.filter(
      (entry) =>
        execCall(entry.payload) &&
        literalCallCommand(entry.payload)?.command === command.command,
    ).length === 1
  );
}

function literalCallCommand(
  payload: Record<string, unknown>,
): LiteralExecutorCommand | undefined {
  if (
    payload.type !== "custom_tool_call" ||
    !["exec", "functions.exec"].includes(String(payload.name))
  )
    return undefined;
  return literalExecutorCommand(payload.input);
}

function mergeLiteralOutputs(
  outputs: Map<number, RecoveredCommandOutput>,
  entries: NativeEntry[],
): void {
  for (const [ordinal, output] of literalCallOutputs(entries)) {
    const earlier = outputs.get(ordinal);
    outputs.set(ordinal, mergedLiteralOutput(output, earlier));
  }
}

/** Actor-local tool output bound to one native command completion. */
export function nativeCommandOutputs(
  entries: NativeEntry[],
): Map<number, RecoveredCommandOutput> {
  const completions = entries.flatMap((entry) => {
    const process = commandProcess(entry);
    return process ? [{ process, entry }] : [];
  });
  const chunks = entries.flatMap((entry) =>
    chunksAtEntry(entry, entries).map((chunk) => ({
      ...chunk,
      ordinal: entry.ordinal,
    })),
  );
  const outputs = new Map<number, RecoveredCommandOutput>();
  mergeYieldedOutputs(outputs, completions, chunks);
  for (const [ordinal, output] of completedCallOutputs(entries)) {
    const earlier = outputs.get(ordinal);
    outputs.set(ordinal, mergedCompletedOutput(output, earlier));
  }
  mergeLiteralOutputs(outputs, entries);
  return outputs;
}

function executorCallType(value: unknown): boolean {
  return value === "custom_tool_call" || value === "function_call";
}
function executorOutputType(value: unknown): boolean {
  return (
    value === "custom_tool_call_output" || value === "function_call_output"
  );
}
function soleEarlierCall(
  calls: NativeEntry[],
  ordinal: number,
): NativeEntry | undefined {
  const [call] = calls;
  if (calls.length !== 1 || call === undefined || call.ordinal >= ordinal)
    return undefined;
  return call;
}
function soleUniqueCommand(
  commands: NativeEntry[],
  entries: NativeEntry[],
): NativeEntry | undefined {
  const [command] = commands;
  if (
    commands.length !== 1 ||
    command === undefined ||
    !uniqueCommandIdentity(command, entries)
  )
    return undefined;
  return command;
}
function mergedLiteralOutput(
  output: string,
  earlier: RecoveredCommandOutput | undefined,
): RecoveredCommandOutput {
  return {
    ...earlier,
    output: output + (earlier?.output ?? ""),
    chunks: earlier?.chunks ?? 0,
    literalCommandCall: true,
  };
}
function mergedCompletedOutput(
  output: string,
  earlier: RecoveredCommandOutput | undefined,
): RecoveredCommandOutput {
  return {
    output: (earlier?.output ?? "") + output,
    chunks: earlier?.chunks ?? 0,
    completedCall: true,
  };
}
function mergeYieldedOutputs(
  outputs: Map<number, RecoveredCommandOutput>,
  completions: { process: string; entry: NativeEntry }[],
  chunks: (YieldedChunk & { ordinal: number })[],
): void {
  for (const { process, entry } of completions) {
    // A reused or duplicated process identifier cannot bind a result uniquely.
    if (completions.filter((other) => other.process === process).length !== 1)
      continue;
    const earlier = chunks
      .filter(
        (chunk) => chunk.process === process && chunk.ordinal < entry.ordinal,
      )
      .sort((a, b) => a.ordinal - b.ordinal);
    if (
      !earlier.length ||
      new Set(earlier.map((chunk) => chunk.id)).size !== earlier.length
    )
      continue;
    outputs.set(entry.ordinal, {
      output: earlier.map((chunk) => chunk.output).join(""),
      chunks: earlier.length,
    });
  }
}
