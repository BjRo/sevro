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
  const wrapper = command.match(
    /^\/bin\/(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/,
  );
  return wrapper?.[2] ?? command;
}

function directReadPath(command: string): string | null {
  const match = shellPayload(command)
    .trim()
    .match(
      /^(?:\/bin\/)?cat\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s'"`$;&|<>]+))$/,
    );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function verifiedSkillRead(
  item: CodexItem,
  workspace: string,
): Promise<string | null> {
  if (typeof item.command !== "string") return null;
  const path = directReadPath(item.command);
  if (!path || typeof item.aggregated_output !== "string") return null;
  const resolved = resolve(workspace, path);
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
  return item.aggregated_output.includes(text) ? skill : null;
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
    const skill = await verifiedSkillRead(item, workspace);
    if (!skill) partial = true;
    else if (!observedSkills.includes(skill)) observedSkills.push(skill);
  }
  return {
    id: "sevro.codex.skill-reads",
    completeness:
      completedTurn && !partial && pending.size === 0 ? "complete" : "partial",
    data: {
      method: "skill_file_read_probe",
      primarySkill: observedSkills[0] ?? null,
      observedSkills,
    },
  };
}
