import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_SKILL_BYTES = 1024 * 1024;
const SKILL_PATH = /^\.agents\/skills\/([A-Za-z0-9._-]+)\/SKILL\.md$/;

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
): Promise<{
  skill: string;
  range: [number, number];
  bodyLength: number;
} | null> {
  if (typeof item.command !== "string") return null;
  const read = directRead(item.command);
  if (!read || typeof item.aggregated_output !== "string") return null;
  const resolved = resolve(workspace, read.path);
  if (!within(workspace, resolved)) return null;
  const match = relative(workspace, resolved)
    .split(sep)
    .join("/")
    .match(SKILL_PATH);
  if (!match) return null;
  const canonicalWorkspace = await realpath(workspace);
  const actual = await realpath(resolved).catch(() => null);
  if (!actual || !within(canonicalWorkspace, actual)) return null;
  const body = await readFile(actual).catch(() => null);
  if (!body || body.byteLength > MAX_SKILL_BYTES) return null;
  const text = body.toString("utf8");
  const skill = match[1]!;
  if (!text.startsWith("---\n") || !text.includes(`\nname: ${skill}\n`))
    return null;
  const range = readRange(text, read);
  if (range[0] === range[1]) return null;
  if (!item.aggregated_output.includes(text.slice(...range))) return null;
  return { skill, range, bodyLength: text.length };
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

/** Retain only ordered mounted-skill names, never commands or skill bodies. */
export async function codexSkillReadObservation(
  stream: string,
  workspace: string,
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
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as CodexEvent;
    const item = event.item;
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
    const read = await verifiedSkillRead(item, workspace);
    if (!read) {
      partial = true;
      continue;
    }
    const coverage = attempted.get(read.skill) ?? {
      ranges: [],
      bodyLength: read.bodyLength,
    };
    coverage.ranges.push(read.range);
    attempted.set(read.skill, coverage);
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
