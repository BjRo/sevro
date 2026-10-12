import { isRecord, isUnknownArray } from "../value-guards";
import type { RecoveredCommandOutput } from "./codex-command-output";
import { nativeCommandOutputs } from "./codex-command-output";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_NATIVE_READ_ATTEMPTS = 64;
const SKILL_PATH = /^\.agents\/skills\/([A-Za-z0-9._-]+)\/SKILL\.md$/;
const PLUGIN_SKILL_PATH = /^skills\/([A-Za-z0-9._-]+)\/SKILL\.md$/;

interface CodexItem {
  id?: unknown;
  type?: unknown;
  command?: unknown;
  status?: unknown;
  exit_code?: unknown;
  aggregated_output?: unknown;
}

interface CodexEvent {
  type?: unknown;
  item?: CodexItem;
}

function shellPayload(command: string): string {
  let payload = command;
  for (let depth = 0; depth < 2; depth++) {
    const wrapper = payload.match(
      /^(?:\/bin\/(?:ba|z)?sh\s+-l?c|lean-ctx\s+-c)\s+(["'])([\s\S]*)\1$/,
    );
    if (!wrapper) break;
    payload = wrapper.slice(2, 3).join("");
  }
  return payload;
}

interface DirectRead {
  path: string;
  fallbackPaths?: string[];
  operandCount?: number;
  firstLine?: number;
  lastLine?: number;
}

function capturedReadPath(match: RegExpMatchArray, first: number): string {
  return match
    .slice(first, first + 3)
    .filter(Boolean)
    .join("");
}
function validReadLines(firstLine: number, lastLine: number): boolean {
  return (
    Number.isSafeInteger(firstLine) &&
    firstLine >= 1 &&
    Number.isSafeInteger(lastLine) &&
    lastLine >= firstLine
  );
}
function sedRead(payload: string, path: string): DirectRead | null {
  const sed = payload.match(
    new RegExp(`^(?:/bin/)?sed\\s+-n\\s+['"]?(\\d+),(\\d+)p['"]?\\s+${path}$`),
  );
  if (!sed) return null;
  const firstLine = Number(sed[1]),
    lastLine = Number(sed[2]);
  if (!validReadLines(firstLine, lastLine)) return null;
  return { path: capturedReadPath(sed, 3), firstLine, lastLine };
}
function directRead(command: string): DirectRead | null {
  const payload = compoundReadPayload(shellPayload(command).trim());
  const path = "(?:\"([^\"]+)\"|'([^']+)'|([^\\s'\"`$;&|<>]+))";
  return (
    catRead(payload, path) ??
    sedRead(payload, path) ??
    fallbackRead(payload, path)
  );
}

const LITERAL_WORD = "(?:\"[^\"$`\\\\]*\"|'[^']*'|[^\\s\"'\\\\`$;&|<>(){}#]+)";
const LITERAL_WORDS = `${LITERAL_WORD}(?:[ \\t]+${LITERAL_WORD})*`;

function compoundReadPayload(payload: string): string {
  const sequential = payload.match(
    new RegExp(
      `^(${LITERAL_WORDS})[ \\t]*[;\\n][ \\t\\r\\n]*(?:/usr/bin/)?rg[ \\t]+${LITERAL_WORDS}[ \\t\\r\\n]*$`,
    ),
  );
  return sequential?.[1] ?? payload;
}

function fallbackRead(payload: string, path: string): DirectRead | null {
  const clause = `(${LITERAL_WORDS})[ \\t]+2>/dev/null[ \\t]*\\|\\|[ \\t\\r\\n]*`;
  const chain = payload.match(
    new RegExp(
      `^((?:${clause})+)true[ \\t]*\\n[ \\t]*(?:/usr/bin/)?rg[ \\t]+${LITERAL_WORDS}[ \\t\\r\\n]*$`,
    ),
  );
  if (!chain) return null;
  const reads = [
    ...chain.slice(1, 2).join("").matchAll(new RegExp(clause, "g")),
  ].map((match) => catRead(match.slice(1, 2).join(""), path));
  if (
    fallbackOperandCount(reads) > MAX_NATIVE_READ_ATTEMPTS ||
    reads.some((read) => read === null)
  )
    return null;
  const paths = reads.flatMap((read) => (read ? [read.path] : []));
  const first = paths[0];
  return first === undefined
    ? null
    : { path: first, fallbackPaths: paths.slice(1) };
}

function fallbackOperandCount(reads: Array<DirectRead | null>): number {
  return reads.reduce((count, read) => count + (read?.operandCount ?? 0), 0);
}

function unsupportedCatOptions(payload: string, paths: string[]): boolean {
  if (/^(?:\/bin\/)?cat\s+--\s/.test(payload)) return false;
  return paths.some((path) => path.startsWith("-"));
}

function catRead(payload: string, path: string): DirectRead | null {
  const cat = payload.match(
    new RegExp(`^(?:/bin/)?cat\\s+(?:--\\s+)?(${path}(?:\\s+${path})*)$`),
  );
  if (!cat) return null;
  const paths = [
    ...cat.slice(1, 2).join("").matchAll(new RegExp(path, "g")),
  ].map((match) => capturedReadPath(match, 1));
  const skills = paths.filter((value) => /(?:^|\/)SKILL\.md$/.test(value));
  if (
    skills.length !== 1 ||
    paths.length > MAX_NATIVE_READ_ATTEMPTS ||
    unsupportedCatOptions(payload, paths)
  )
    return null;
  return { path: skills.join(""), operandCount: paths.length };
}

function readRange(body: string, read: DirectRead): [number, number] {
  if (read.firstLine === undefined || read.lastLine === undefined)
    return [0, body.length];
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const start = lines.slice(0, read.firstLine - 1).join("").length;
  const end = lines.slice(0, read.lastLine).join("").length;
  return [start, end];
}

type VerifiedRead = {
  skill: string;
  path: string;
  range: [number, number];
  bodyLength: number;
};
function readDeclaration(
  item: CodexItem,
): { read: DirectRead; output: string } | null {
  if (typeof item.command !== "string") return null;
  const read = directRead(item.command);
  if (!read || typeof item.aggregated_output !== "string") return null;
  return { read, output: item.aggregated_output };
}
async function verifiedSkillRead(
  item: CodexItem,
  workspace: string,
  pluginRoots: string[],
  commandCwd = workspace,
): Promise<VerifiedRead | null> {
  const declaration = readDeclaration(item);
  if (!declaration) return null;
  return resolvedSkillRead(declaration, workspace, pluginRoots, commandCwd);
}
async function mountedSkillReadAttempt(
  command: string,
  workspace: string,
  pluginRoots: string[],
  commandCwd = workspace,
): Promise<boolean> {
  for (const path of readAttemptPaths(command)) {
    if (await mountedReadPath(path, commandCwd, workspace, pluginRoots))
      return true;
  }
  return false;
}
async function mountedReadPath(
  path: string,
  commandCwd: string,
  workspace: string,
  pluginRoots: string[],
): Promise<boolean> {
  const absolute = resolve(commandCwd, path);
  const actual = await realpath(absolute).catch(() => null);
  return (
    actual !== null && mountedSkillName(actual, workspace, pluginRoots) !== null
  );
}
function readAttemptPaths(command: string): string[] {
  const payload = compoundReadPayload(shellPayload(command).trim());
  const path = "(?:\"([^\"]+)\"|'([^']+)'|([^\\s'\"`$;&|<>]+))";
  const fallback = fallbackRead(payload, path);
  if (fallback) return [fallback.path, ...(fallback.fallbackPaths ?? [])];
  return literalReadAttemptPaths(payload, path);
}
function literalReadAttemptPaths(payload: string, path: string): string[] {
  const cat = payload.match(
    new RegExp(`^(?:/bin/)?cat\\s+(?:--\\s+)?(${path}(?:\\s+${path})*)$`),
  );
  if (cat) {
    return [...cat.slice(1, 2).join("").matchAll(new RegExp(path, "g"))]
      .map((match) => capturedReadPath(match, 1))
      .filter((value) => /(?:^|\/)SKILL\.md$/.test(value));
  }
  const sed = payload.match(
    new RegExp(`^(?:/bin/)?sed\\s+-n\\s+[^\\s]+\\s+${path}$`),
  );
  if (sed) {
    const value = capturedReadPath(sed, 2);
    if (/(?:^|\/)SKILL\.md$/.test(value)) return [value];
  }
  return [];
}
async function exposesMountedSkillFrontmatter(
  output: string,
  workspace: string,
  pluginRoots: string[],
): Promise<boolean> {
  const skills = new Set(
    [...output.matchAll(/(?:^|\n)name: ([A-Za-z0-9._-]+)\r?$/gm)]
      .map((match) => match[1])
      .filter((skill): skill is string => skill !== undefined),
  );
  for (const skill of skills) {
    const paths = [
      resolve(workspace, ".agents", "skills", skill, "SKILL.md"),
      ...pluginRoots.map((root) => resolve(root, "skills", skill, "SKILL.md")),
    ];
    for (const path of paths)
      if (
        await verifiedMountedFrontmatterPath(
          path,
          skill,
          workspace,
          pluginRoots,
        )
      )
        return true;
  }
  return false;
}
async function verifiedMountedFrontmatterPath(
  path: string,
  skill: string,
  workspace: string,
  pluginRoots: string[],
): Promise<boolean> {
  const actual = await realpath(path).catch(() => null);
  if (actual && mountedSkillName(actual, workspace, pluginRoots) === skill)
    if ((await verifiedSkillBody(actual, skill)) !== null) return true;
  const directory = await realpath(dirname(path)).catch(() => null);
  return (
    directory !== null &&
    mountedSkillDirectoryName(directory, workspace, pluginRoots) === skill
  );
}
function mountedSkillDirectoryName(
  directory: string,
  workspace: string,
  pluginRoots: string[],
): string | null {
  const mounted = relative(workspace, directory)
    .split(sep)
    .join("/")
    .match(/^\.agents\/skills\/([A-Za-z0-9._-]+)$/);
  const plugin = pluginRoots
    .map((root) =>
      relative(root, directory)
        .split(sep)
        .join("/")
        .match(/^skills\/([A-Za-z0-9._-]+)$/),
    )
    .find((match) => match !== null);
  return (mounted ?? plugin)?.[1] ?? null;
}
function mountedSkillName(
  actual: string,
  workspace: string,
  pluginRoots: string[],
): string | null {
  const mounted = relative(workspace, actual)
    .split(sep)
    .join("/")
    .match(SKILL_PATH);
  const plugin = pluginRoots
    .map((root) =>
      relative(root, actual).split(sep).join("/").match(PLUGIN_SKILL_PATH),
    )
    .find((match) => match !== null);
  const match = mounted ?? plugin;
  return match ? match.slice(1, 2).join("") : null;
}
async function verifiedSkillBody(
  actual: string,
  skill: string,
): Promise<string | null> {
  const body = await readFile(actual).catch(() => null);
  if (!body || body.byteLength > MAX_SKILL_BYTES) return null;
  const text = body.toString("utf8");
  if (!text.startsWith("---\n") || !text.includes(`\nname: ${skill}\n`))
    return null;
  return text;
}
async function resolvedSkillRead(
  declaration: { read: DirectRead; output: string },
  workspace: string,
  pluginRoots: string[],
  commandCwd: string,
): Promise<VerifiedRead | null> {
  const actual = await resolvedReadPath(declaration.read, commandCwd);
  if (!actual) return null;
  const skill = mountedSkillName(actual, workspace, pluginRoots);
  if (skill === null) return null;
  const text = await verifiedSkillBody(actual, skill);
  if (text === null) return null;
  return skillReadReceipt(actual, skill, declaration, text);
}
async function resolvedReadPath(
  read: DirectRead,
  commandCwd: string,
): Promise<string | null> {
  const targets = new Set<string>();
  for (const path of [read.path, ...(read.fallbackPaths ?? [])]) {
    const actual = await realpath(resolve(commandCwd, path)).catch(() => null);
    if (actual) targets.add(actual);
  }
  return targets.size === 1 ? [...targets].join("") : null;
}
function skillReadReceipt(
  actual: string,
  skill: string,
  declaration: { read: DirectRead; output: string },
  text: string,
): VerifiedRead | null {
  const range = readRange(text, declaration.read);
  if (range[0] === range[1]) return null;
  if (!declaration.output.includes(text.slice(...range))) return null;
  return { skill, path: actual, range, bodyLength: text.length };
}

function fullCoverage(
  ranges: Array<[number, number]>,
  length: number,
): boolean {
  const ordered = ranges.sort((left, right) => left[0] - right[0]);
  let covered = 0;
  for (const [start, end] of ordered) {
    if (start > covered) return false;
    covered = Math.max(covered, end);
  }
  return covered === length;
}

interface NativeEntry {
  ordinal: number;
  payload: Record<string, unknown>;
}

export interface NativeReadDiagnostic {
  completeness: "complete" | "partial";
  observedSkills: string[];
  completedReads: Array<{ skill: string; ordinal: number }>;
  recoverySources: Array<{
    ordinal: number;
    nativeOutput: boolean;
    yieldedChunks: number;
    completedCall: boolean;
    literalCommandCall: boolean;
  }>;
  commandExecutions: number;
  readAttempts: number;
  truncated: boolean;
}

function nativeShellArguments(value: string[]): boolean {
  return value.length >= 3 && (value[1] === "-lc" || value[1] === "-c");
}
function nativeCommandText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    !isUnknownArray(value) ||
    !value.every((part): part is string => typeof part === "string")
  )
    return null;
  return nativeShellArguments(value)
    ? value.slice(2).join(" ")
    : value.join(" ");
}

type Coverage = { ranges: Array<[number, number]>; bodyLength: number };
interface CoverageState {
  attempted: Map<string, Coverage>;
  observedSkills: string[];
}
interface NativeReadState extends CoverageState {
  completedReads: NativeReadDiagnostic["completedReads"];
  recoverySources: NativeReadDiagnostic["recoverySources"];
  commandExecutions: number;
  readAttempts: number;
  partial: boolean;
  truncated: boolean;
}
interface ReadContext {
  workspace: string;
  pluginRoots: string[];
  recovered: Map<number, RecoveredCommandOutput>;
}
function nativeReadState(): NativeReadState {
  return {
    attempted: new Map(),
    observedSkills: [],
    completedReads: [],
    recoverySources: [],
    commandExecutions: 0,
    readAttempts: 0,
    partial: false,
    truncated: false,
  };
}

/** Verify native skill-file reads without retaining commands or output. */
export async function codexNativeReadDiagnostic(
  entries: NativeEntry[],
  workspace: string,
  installedPluginRoots: string[] = [],
): Promise<NativeReadDiagnostic> {
  const canonicalWorkspace = await realpath(workspace);
  const pluginRoots = await Promise.all(
    installedPluginRoots.map((root) => realpath(root)),
  );
  const context: ReadContext = {
    workspace: canonicalWorkspace,
    pluginRoots,
    recovered: nativeCommandOutputs(entries),
  };
  const state = nativeReadState();
  for (const entry of entries)
    if (!(await nativeReadEntry(entry, context, state))) break;
  return nativeReadResult(state);
}

function nativeCommandItem(
  payload: Record<string, unknown>,
): (CodexItem & { cwd?: unknown }) | null {
  if (
    payload.type !== "item_completed" ||
    !isRecord(payload.item) ||
    payload.item.type !== "CommandExecution"
  )
    return null;
  return payload.item;
}

async function nativeReadEntry(
  { ordinal, payload }: NativeEntry,
  context: ReadContext,
  state: NativeReadState,
): Promise<boolean> {
  const item = nativeCommandItem(payload);
  if (!item) return true;
  state.commandExecutions++;
  const command = nativeCommandText(item.command);
  if (!command) {
    if (
      await exposesMountedSkillFrontmatter(
        combinedNativeOutput(item, context.recovered.get(ordinal)),
        context.workspace,
        context.pluginRoots,
      )
    ) {
      if (!countNativeRead(state)) return false;
      const recovered = context.recovered.get(ordinal);
      state.recoverySources.push({
        ordinal,
        nativeOutput: hasNativeOutput(item),
        ...recoveryFlags(recovered),
      });
      state.partial = true;
    }
    return true;
  }
  return processNativeRead(item, command, ordinal, context, state);
}

function countNativeRead(state: NativeReadState): boolean {
  state.readAttempts++;
  if (state.readAttempts <= MAX_NATIVE_READ_ATTEMPTS) return true;
  state.readAttempts = MAX_NATIVE_READ_ATTEMPTS;
  state.truncated = true;
  state.partial = true;
  return false;
}

async function processNativeRead(
  item: CodexItem & { cwd?: unknown },
  command: string,
  ordinal: number,
  context: ReadContext,
  state: NativeReadState,
): Promise<boolean> {
  const attempted = await nativeSkillReadAttempt(item, command, context);
  const exposed = await exposesMountedSkillFrontmatter(
    combinedNativeOutput(item, context.recovered.get(ordinal)),
    context.workspace,
    context.pluginRoots,
  );
  if (!attempted && !exposed) return true;
  if (!countNativeRead(state)) return false;
  const recovered = context.recovered.get(ordinal);
  state.recoverySources.push({
    ordinal,
    nativeOutput: hasNativeOutput(item),
    ...recoveryFlags(recovered),
  });
  if (!attempted) {
    state.partial = true;
    return true;
  }
  await completeNativeRead(item, command, ordinal, context, state);
  return true;
}
async function nativeSkillReadAttempt(
  item: CodexItem & { cwd?: unknown },
  command: string,
  context: ReadContext,
): Promise<boolean> {
  const cwd = await nativeReadCwd(item.cwd, context.workspace);
  if (cwd === null) return readAttemptPaths(command).length > 0;
  return mountedSkillReadAttempt(
    command,
    context.workspace,
    context.pluginRoots,
    cwd,
  );
}
function hasNativeOutput(item: CodexItem): boolean {
  return (
    typeof item.aggregated_output === "string" &&
    item.aggregated_output.length > 0
  );
}
function recoveryFlags(recovered: RecoveredCommandOutput | undefined) {
  return {
    yieldedChunks: recovered?.chunks ?? 0,
    completedCall: recovered?.completedCall === true,
    literalCommandCall: recovered?.literalCommandCall === true,
  };
}
function successfulReadCommand(item: CodexItem): boolean {
  return item.exit_code === 0 && item.status === "completed";
}
async function nativeReadCwd(
  cwd: unknown,
  workspace: string,
): Promise<string | null> {
  if (cwd === undefined) return workspace;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  return realpath(cwd).catch(() => null);
}
function nativeOutput(item: CodexItem): string {
  return typeof item.aggregated_output === "string"
    ? item.aggregated_output
    : "";
}
function combinedNativeOutput(
  item: CodexItem,
  recovered: RecoveredCommandOutput | undefined,
): string {
  return (recovered?.output ?? "") + nativeOutput(item);
}
async function completeNativeRead(
  item: CodexItem & { cwd?: unknown },
  command: string,
  ordinal: number,
  context: ReadContext,
  state: NativeReadState,
): Promise<void> {
  if (!successfulReadCommand(item)) {
    state.partial = true;
    return;
  }
  const cwd = await nativeReadCwd(item.cwd, context.workspace);
  if (!cwd) {
    state.partial = true;
    return;
  }
  const read = await verifiedSkillRead(
    {
      ...item,
      command,
      aggregated_output: combinedNativeOutput(
        item,
        context.recovered.get(ordinal),
      ),
    },
    context.workspace,
    context.pluginRoots,
    cwd,
  );
  if (!read) {
    state.partial = true;
    return;
  }
  retainNativeRead(state, read, ordinal);
}
function continuingNativeCoverage(
  state: NativeReadState,
  read: VerifiedRead,
): Coverage {
  const prior = state.attempted.get(read.path);
  return prior && !fullCoverage(prior.ranges, prior.bodyLength)
    ? prior
    : { ranges: [], bodyLength: read.bodyLength };
}
function appendReadCoverage(
  state: CoverageState,
  read: VerifiedRead,
  coverage: Coverage,
): boolean {
  coverage.ranges.push(read.range);
  state.attempted.set(read.path, coverage);
  return fullCoverage(coverage.ranges, coverage.bodyLength);
}
function retainNativeRead(
  state: NativeReadState,
  read: VerifiedRead,
  ordinal: number,
): void {
  const coverage = continuingNativeCoverage(state, read);
  if (appendReadCoverage(state, read, coverage)) {
    state.completedReads.push({ skill: read.skill, ordinal });
    if (!state.observedSkills.includes(read.skill))
      state.observedSkills.push(read.skill);
  }
}
function completeCoverage(state: CoverageState): boolean {
  return [...state.attempted.values()].every(({ ranges, bodyLength }) =>
    fullCoverage(ranges, bodyLength),
  );
}
function nativeReadResult(state: NativeReadState): NativeReadDiagnostic {
  return {
    completeness:
      !state.partial && completeCoverage(state) ? "complete" : "partial",
    observedSkills: state.observedSkills,
    completedReads: state.completedReads,
    recoverySources: state.recoverySources,
    commandExecutions: state.commandExecutions,
    readAttempts: state.readAttempts,
    truncated: state.truncated,
  };
}

interface StreamReadState extends CoverageState {
  pending: Set<string>;
  partial: boolean;
  completedTurn: boolean;
}
type RecoveredRead = { command: string; output: string };
function streamReadState(): StreamReadState {
  return {
    attempted: new Map(),
    observedSkills: [],
    pending: new Set(),
    partial: false,
    completedTurn: false,
  };
}
function readEvent(line: string): CodexEvent {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error("Invalid Codex skill-read event");
  return {
    type: value.type,
    item: isRecord(value.item) ? value.item : undefined,
  };
}
function recoveredReadItem(
  item: CodexItem | undefined,
  recoveredReads: Map<string, RecoveredRead>,
): CodexItem | undefined {
  if (typeof item?.id !== "string") return item;
  return correlatedReadItem(item, recoveredReads.get(item.id));
}
function correlatedReadItem(
  item: CodexItem,
  recovered: RecoveredRead | undefined,
): CodexItem {
  if (
    !recovered ||
    typeof item.command !== "string" ||
    shellPayload(item.command) !== shellPayload(recovered.command)
  )
    return item;
  return { ...item, aggregated_output: recovered.output + nativeOutput(item) };
}
function observeStreamTurn(event: CodexEvent, state: StreamReadState): void {
  if (event.type === "turn.completed") state.completedTurn = true;
  if (event.type === "turn.failed") state.partial = true;
}
async function streamReadEvent(
  event: CodexEvent,
  item: CodexItem | undefined,
  context: Pick<ReadContext, "workspace" | "pluginRoots">,
  state: StreamReadState,
): Promise<void> {
  observeStreamTurn(event, state);
  if (!item || item.type !== "command_execution") return;
  if (event.type === "item.started") {
    await pendingStreamRead(item, context, state);
    return;
  }
  if (event.type !== "item.completed") return;
  await completeStreamRead(item, context, state);
}
async function pendingStreamRead(
  item: CodexItem,
  context: Pick<ReadContext, "workspace" | "pluginRoots">,
  state: StreamReadState,
): Promise<void> {
  if (
    typeof item.command !== "string" ||
    !(await mountedSkillReadAttempt(
      item.command,
      context.workspace,
      context.pluginRoots,
    ))
  )
    return;
  if (typeof item.id === "string") state.pending.add(item.id);
  else state.partial = true;
}
async function eligibleCompletedRead(
  item: CodexItem,
  context: Pick<ReadContext, "workspace" | "pluginRoots">,
  state: StreamReadState,
): Promise<boolean> {
  const wasPending =
    typeof item.id === "string" && state.pending.delete(item.id);
  if (await completedMountedRead(item, context, state)) return true;
  if (wasPending) {
    state.partial = true;
    return false;
  }
  state.partial ||= await exposesMountedSkillFrontmatter(
    nativeOutput(item),
    context.workspace,
    context.pluginRoots,
  );
  return false;
}
async function completedMountedRead(
  item: CodexItem,
  context: Pick<ReadContext, "workspace" | "pluginRoots">,
  state: StreamReadState,
): Promise<boolean> {
  if (typeof item.command !== "string") return false;
  const attempted = await mountedSkillReadAttempt(
    item.command,
    context.workspace,
    context.pluginRoots,
  );
  if (!attempted) return false;
  if (!successfulReadCommand(item)) state.partial = true;
  return successfulReadCommand(item);
}
async function completeStreamRead(
  item: CodexItem,
  context: Pick<ReadContext, "workspace" | "pluginRoots">,
  state: StreamReadState,
): Promise<void> {
  if (!(await eligibleCompletedRead(item, context, state))) return;
  const read = await verifiedSkillRead(
    item,
    context.workspace,
    context.pluginRoots,
  );
  if (!read) {
    state.partial = true;
    return;
  }
  const coverage = state.attempted.get(read.path) ?? {
    ranges: [],
    bodyLength: read.bodyLength,
  };
  retainStreamRead(state, read, coverage);
}

function retainStreamRead(
  state: StreamReadState,
  read: VerifiedRead,
  coverage: Coverage,
): void {
  if (
    appendReadCoverage(state, read, coverage) &&
    !state.observedSkills.includes(read.skill)
  )
    state.observedSkills.push(read.skill);
}
function streamReadCompleteness(
  state: StreamReadState,
): "complete" | "partial" {
  return state.completedTurn &&
    !state.partial &&
    state.pending.size === 0 &&
    completeCoverage(state)
    ? "complete"
    : "partial";
}
function streamReadResult(state: StreamReadState) {
  return {
    id: "sevro.codex.skill-reads" as const,
    completeness: streamReadCompleteness(state),
    data: {
      method: "skill_file_read_probe",
      primarySkill: state.observedSkills[0] ?? null,
      observedSkills: state.observedSkills,
    },
  };
}

/** Retain only ordered mounted-skill names, never commands or skill bodies. */
export async function codexSkillReadObservation(
  stream: string,
  workspace: string,
  installedPluginRoots: string[] = [],
  recoveredReads: Map<string, RecoveredRead> = new Map(),
) {
  const state = streamReadState();
  const canonicalWorkspace = await realpath(workspace);
  const pluginRoots = await Promise.all(
    installedPluginRoots.map((root) => realpath(root)),
  );
  const context = { workspace: canonicalWorkspace, pluginRoots };
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    const event = readEvent(line);
    const item = recoveredReadItem(event.item, recoveredReads);
    await streamReadEvent(event, item, context, state);
  }
  return streamReadResult(state);
}
