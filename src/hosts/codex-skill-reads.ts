import { nativeCommandOutputs } from "./codex-command-output";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
    payload = wrapper[2]!;
  }
  return payload;
}

interface DirectRead {
  path: string;
  firstLine?: number;
  lastLine?: number;
}

function directRead(command: string): DirectRead | null {
  const payload = shellPayload(command).trim();
  const path = "(?:\"([^\"]+)\"|'([^']+)'|([^\\s'\"`$;&|<>]+))";
  const cat = payload.match(
    new RegExp(`^(?:/bin/)?cat\\s+(?:--\\s+)?${path}$`),
  );
  if (cat) return { path: cat[1] ?? cat[2] ?? cat[3]! };
  const sed = payload.match(
    new RegExp(`^(?:/bin/)?sed\\s+-n\\s+['"]?(\\d+),(\\d+)p['"]?\\s+${path}$`),
  );
  if (!sed) return null;
  const firstLine = Number(sed[1]);
  const lastLine = Number(sed[2]);
  if (
    !Number.isSafeInteger(firstLine) ||
    firstLine < 1 ||
    !Number.isSafeInteger(lastLine) ||
    lastLine < firstLine
  )
    return null;
  return { path: sed[3] ?? sed[4] ?? sed[5]!, firstLine, lastLine };
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function readRange(body: string, read: DirectRead): [number, number] {
  if (read.firstLine === undefined || read.lastLine === undefined)
    return [0, body.length];
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const start = lines.slice(0, read.firstLine - 1).join("").length;
  const end = lines.slice(0, read.lastLine).join("").length;
  return [start, end];
}

async function verifiedSkillRead(
  item: CodexItem,
  workspace: string,
  pluginRoots: string[],
  commandCwd = workspace,
): Promise<{
  skill: string;
  path: string;
  range: [number, number];
  bodyLength: number;
} | null> {
  if (typeof item.command !== "string") return null;
  const read = directRead(item.command);
  if (!read || typeof item.aggregated_output !== "string") return null;
  const resolved = resolve(commandCwd, read.path);
  const actual = await realpath(resolved).catch(() => null);
  if (!actual) return null;
  const mountedMatch = relative(workspace, actual)
    .split(sep)
    .join("/")
    .match(SKILL_PATH);
  const pluginMatch = pluginRoots
    .map((root) =>
      relative(root, actual).split(sep).join("/").match(PLUGIN_SKILL_PATH),
    )
    .find((match) => match !== null);
  const match = mountedMatch ?? pluginMatch;
  if (!match) return null;
  const body = await readFile(actual).catch(() => null);
  if (!body || body.byteLength > MAX_SKILL_BYTES) return null;
  const text = body.toString("utf8");
  const skill = match[1]!;
  if (!text.startsWith("---\n") || !text.includes(`\nname: ${skill}\n`))
    return null;
  const range = readRange(text, read);
  if (range[0] === range[1]) return null;
  if (!item.aggregated_output.includes(text.slice(...range))) return null;
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

function nativeCommandText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string"))
    return null;
  if (value.length >= 3 && (value[1] === "-lc" || value[1] === "-c"))
    return value.slice(2).join(" ");
  return value.join(" ");
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
  const recoveredOutputs = nativeCommandOutputs(entries);
  const attempted = new Map<
    string,
    { ranges: Array<[number, number]>; bodyLength: number }
  >();
  const observedSkills: string[] = [];
  const completedReads: Array<{ skill: string; ordinal: number }> = [];
  const recoverySources: NativeReadDiagnostic["recoverySources"] = [];
  let commandExecutions = 0;
  let readAttempts = 0;
  let partial = false;
  let truncated = false;
  for (const { ordinal, payload } of entries) {
    const item = payload.item;
    if (
      payload.type !== "item_completed" ||
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      (item as CodexItem).type !== "CommandExecution"
    )
      continue;
    const commandItem = item as CodexItem & { cwd?: unknown };
    commandExecutions++;
    const command = nativeCommandText(commandItem.command);
    if (!command) {
      partial = true;
      continue;
    }
    if (!command.includes("SKILL.md")) continue;
    readAttempts++;
    if (readAttempts > MAX_NATIVE_READ_ATTEMPTS) {
      readAttempts = MAX_NATIVE_READ_ATTEMPTS;
      truncated = true;
      partial = true;
      break;
    }
    const recovered = recoveredOutputs.get(ordinal);
    recoverySources.push({
      ordinal,
      nativeOutput:
        typeof commandItem.aggregated_output === "string" &&
        commandItem.aggregated_output.length > 0,
      yieldedChunks: recovered?.chunks ?? 0,
      completedCall: recovered?.completedCall === true,
      literalCommandCall: recovered?.literalCommandCall === true,
    });
    if (
      typeof commandItem.exit_code !== "number" ||
      commandItem.status !== "completed"
    ) {
      partial = true;
      continue;
    }
    const cwd =
      commandItem.cwd === undefined
        ? canonicalWorkspace
        : typeof commandItem.cwd === "string" && isAbsolute(commandItem.cwd)
          ? await realpath(commandItem.cwd).catch(() => null)
          : null;
    if (!cwd) {
      partial = true;
      continue;
    }
    const read = await verifiedSkillRead(
      {
        ...commandItem,
        command,
        aggregated_output:
          (recoveredOutputs.get(ordinal)?.output ?? "") +
          (typeof commandItem.aggregated_output === "string"
            ? commandItem.aggregated_output
            : ""),
      },
      canonicalWorkspace,
      pluginRoots,
      cwd,
    );
    if (!read) {
      partial = true;
      continue;
    }
    const prior = attempted.get(read.path);
    const coverage =
      prior && !fullCoverage(prior.ranges, prior.bodyLength)
        ? prior
        : {
            ranges: [],
            bodyLength: read.bodyLength,
          };
    coverage.ranges.push(read.range);
    attempted.set(read.path, coverage);
    if (fullCoverage(coverage.ranges, coverage.bodyLength)) {
      completedReads.push({ skill: read.skill, ordinal });
      if (!observedSkills.includes(read.skill)) observedSkills.push(read.skill);
    }
  }
  return {
    completeness:
      !partial &&
      [...attempted.values()].every(({ ranges, bodyLength }) =>
        fullCoverage(ranges, bodyLength),
      )
        ? "complete"
        : "partial",
    observedSkills,
    completedReads,
    recoverySources,
    commandExecutions,
    readAttempts,
    truncated,
  };
}

/** Retain only ordered mounted-skill names, never commands or skill bodies. */
export async function codexSkillReadObservation(
  stream: string,
  workspace: string,
  installedPluginRoots: string[] = [],
  recoveredReads: Map<string, { command: string; output: string }> = new Map(),
): Promise<{
  id: "sevro.codex.skill-reads";
  completeness: "complete" | "partial";
  data: {
    method: "skill_file_read_probe";
    primarySkill: string | null;
    observedSkills: string[];
  };
}> {
  const observedSkills: string[] = [];
  const attempted = new Map<
    string,
    { ranges: Array<[number, number]>; bodyLength: number }
  >();
  const pending = new Set<string>();
  let partial = false;
  let completedTurn = false;
  const canonicalWorkspace = await realpath(workspace);
  const pluginRoots = await Promise.all(
    installedPluginRoots.map((root) => realpath(root)),
  );
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as CodexEvent;
    let item = event.item;
    if (typeof item?.id === "string") {
      const recovered = recoveredReads.get(item.id);
      if (
        recovered &&
        typeof item.command === "string" &&
        shellPayload(item.command) === shellPayload(recovered.command)
      )
        item = {
          ...item,
          aggregated_output:
            recovered.output +
            (typeof item.aggregated_output === "string"
              ? item.aggregated_output
              : ""),
        };
    }
    if (event.type === "turn.completed") completedTurn = true;
    if (event.type === "turn.failed") partial = true;
    if (!item || item.type !== "command_execution") continue;
    if (event.type === "item.started") {
      if (
        typeof item.command === "string" &&
        item.command.includes("SKILL.md")
      ) {
        if (typeof item.id === "string") pending.add(item.id);
        else partial = true;
      }
      continue;
    }
    if (event.type !== "item.completed") continue;
    if (typeof item.id === "string") pending.delete(item.id);
    if (typeof item.command !== "string") {
      partial = true;
      continue;
    }
    if (!item.command.includes("SKILL.md")) continue;
    if (typeof item.exit_code !== "number" || item.status !== "completed") {
      partial = true;
      continue;
    }
    const read = await verifiedSkillRead(item, canonicalWorkspace, pluginRoots);
    if (!read) {
      partial = true;
      continue;
    }
    const coverage = attempted.get(read.path) ?? {
      ranges: [],
      bodyLength: read.bodyLength,
    };
    coverage.ranges.push(read.range);
    attempted.set(read.path, coverage);
    if (
      fullCoverage(coverage.ranges, coverage.bodyLength) &&
      !observedSkills.includes(read.skill)
    )
      observedSkills.push(read.skill);
  }
  return {
    id: "sevro.codex.skill-reads",
    completeness:
      completedTurn &&
      !partial &&
      pending.size === 0 &&
      [...attempted.values()].every(({ ranges, bodyLength }) =>
        fullCoverage(ranges, bodyLength),
      )
        ? "complete"
        : "partial",
    data: {
      method: "skill_file_read_probe",
      primarySkill: observedSkills[0] ?? null,
      observedSkills,
    },
  };
}
