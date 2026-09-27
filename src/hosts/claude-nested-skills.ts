import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

type Entry = Record<string, unknown>;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_AGENTS = 64;
const MAX_SKILLS = 128;

function record(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function label(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}

function identity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function blocks(entry: Entry): Entry[] {
  const content = record(entry.message) ? entry.message.content : null;
  return Array.isArray(content) ? content.filter(record) : [];
}

function entries(text: string): Entry[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!record(parsed)) throw new Error("invalid Claude session entry");
      return parsed;
    });
}

async function readSession(path: string): Promise<string> {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_BYTES)
    throw new Error("Claude session file is unavailable");
  return readFile(path, "utf8");
}

type NestedSkill = {
  ancestorToolUseId: string;
  skill: string;
  invocation: string;
};

type State = {
  sessionId: string;
  projectDir: string;
  seen: Set<string>;
  calls: NestedSkill[];
};

async function sidecarChild(
  state: State,
  toolUseId: string,
  parentAgentId: string | null,
): Promise<string> {
  const directory = join(state.projectDir, state.sessionId, "subagents");
  const names = (await readdir(directory)).filter((name) =>
    /^agent-[A-Za-z0-9_-]+\.meta\.json$/.test(name),
  );
  if (names.length > MAX_AGENTS) throw new Error("excessive Claude agents");
  const matches: string[] = [];
  for (const name of names) {
    const metadata: unknown = JSON.parse(
      await readSession(join(directory, name)),
    );
    if (
      record(metadata) &&
      metadata.toolUseId === toolUseId &&
      (metadata.parentAgentId ?? null) === parentAgentId
    )
      matches.push(name.slice(6, -10));
  }
  if (matches.length !== 1 || !identity(matches[0]))
    throw new Error("Claude child identity is unavailable");
  return matches[0]!;
}

async function childId(
  entry: Entry,
  state: State,
  toolUseId: string,
  parentAgentId: string | null,
): Promise<string> {
  const result = record(entry.toolUseResult) ? entry.toolUseResult : null;
  if (result) {
    if (result.status !== "completed" || !identity(result.agentId))
      throw new Error("Claude child did not complete");
    return result.agentId;
  }
  return sidecarChild(state, toolUseId, parentAgentId);
}

async function childSession(state: State, agentId: string) {
  const directory = join(state.projectDir, state.sessionId, "subagents");
  const path = join(directory, `agent-${agentId}.jsonl`);
  if ((await realpath(path)) !== path)
    throw new Error("Claude child session is redirected");
  return readSession(path);
}

function skillCall(block: Entry, ancestorToolUseId: string | null) {
  const invocation = record(block.input) ? block.input.skill : null;
  if (!label(invocation)) throw new Error("invalid Claude Skill call");
  return ancestorToolUseId
    ? {
        ancestorToolUseId,
        skill: invocation.split(":").at(-1)!,
        invocation,
      }
    : null;
}

async function visit(
  text: string,
  state: State,
  agentId: string | null,
  ancestorToolUseId: string | null,
): Promise<void> {
  const pending = new Set<string>();
  for (const entry of entries(text)) {
    if (entry.type !== "assistant" && entry.type !== "user") continue;
    if (
      entry.sessionId !== state.sessionId ||
      (entry.agentId ?? null) !== agentId
    )
      throw new Error("Claude session identity mismatch");
    for (const block of blocks(entry)) {
      if (entry.type === "assistant" && block.type === "tool_use") {
        if (block.name === "Skill") {
          const call = skillCall(block, ancestorToolUseId);
          if (call) state.calls.push(call);
          if (state.calls.length > MAX_SKILLS)
            throw new Error("excessive Claude Skill calls");
        }
        if (block.name === "Agent" || block.name === "Task") {
          if (!identity(block.id) || pending.has(block.id))
            throw new Error("invalid Claude Agent call");
          pending.add(block.id);
        }
      }
      if (
        entry.type === "user" &&
        block.type === "tool_result" &&
        identity(block.tool_use_id) &&
        pending.has(block.tool_use_id)
      ) {
        if (block.is_error === true)
          throw new Error("Claude child call failed");
        const child = await childId(entry, state, block.tool_use_id, agentId);
        if (state.seen.has(child) || state.seen.size >= MAX_AGENTS)
          throw new Error("repeated Claude child");
        state.seen.add(child);
        await visit(
          await childSession(state, child),
          state,
          child,
          ancestorToolUseId ?? block.tool_use_id,
        );
        pending.delete(block.tool_use_id);
      }
    }
  }
  if (pending.size) throw new Error("incomplete Claude Agent graph");
}

export async function claudeNestedSkillsObservation(
  stream: string,
  configRoot: string,
  workspace: string,
) {
  const unavailable = {
    id: "sevro.claude.nested-skills" as const,
    completeness: "partial" as const,
    data: { method: "native_session_graph", calls: [] as NestedSkill[] },
  };
  try {
    const sessions = [
      ...new Set(
        entries(stream)
          .filter((entry) => entry.type === "result")
          .map((entry) => entry.session_id),
      ),
    ];
    if (sessions.length !== 1 || !identity(sessions[0])) return unavailable;
    const canonicalWorkspace = await realpath(workspace);
    const canonicalConfigRoot = await realpath(configRoot);
    const projectDir = join(
      canonicalConfigRoot,
      "projects",
      canonicalWorkspace.replace(/[^A-Za-z0-9]/g, "-"),
    );
    const state: State = {
      sessionId: sessions[0],
      projectDir,
      seen: new Set(),
      calls: [],
    };
    await visit(
      await readSession(join(projectDir, `${state.sessionId}.jsonl`)),
      state,
      null,
      null,
    );
    return {
      id: "sevro.claude.nested-skills" as const,
      completeness: "complete" as const,
      data: { method: "native_session_graph", calls: state.calls },
    };
  } catch {
    return unavailable;
  }
}
