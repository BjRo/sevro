import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { HostAdapter } from "../engine";
import type { ClaudeToolCallsObservation } from "./claude-tool-calls";

type Entry = Record<string, unknown>;
export interface ClaudeRepositoryInvocation {
  skillName: string;
  skillDir: string;
  skillText: string;
  prompt: string;
}

function record(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entries(text: string): Entry[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!record(value)) throw new Error("invalid Claude session entry");
      return value;
    });
}

function content(entry: Entry): string {
  const blocks = record(entry.message) ? entry.message.content : null;
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter(record)
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/** Validate the native project mount before candidate execution. */
export async function verifyClaudeRepositoryInvocation(
  request: Parameters<HostAdapter["run"]>[0],
): Promise<ClaudeRepositoryInvocation> {
  const selected = request.explicitSkillInvocation;
  if (!selected || selected.scope !== "repository")
    throw new Error("Claude repository invocation is not declared");
  const { skillName, token } = selected;
  if (
    !/^[A-Za-z0-9._-]+$/.test(skillName) ||
    [".", ".."].includes(skillName) ||
    token !== `/${skillName}` ||
    request.prompt.split(token).length - 1 !== 1 ||
    (request.prompt !== token &&
      !request.prompt.startsWith(token + " ") &&
      !request.prompt.startsWith(token + "\n"))
  )
    throw new Error("invalid Claude repository skill invocation");
  let path = await realpath(request.workspace);
  for (const [index, part] of [
    ".claude",
    "skills",
    skillName,
    "SKILL.md",
  ].entries()) {
    path = join(path, part);
    const entry = await lstat(path).catch(() => null);
    if (
      !entry ||
      entry.isSymbolicLink() ||
      (index === 3
        ? !entry.isFile() || entry.size > 1024 * 1024
        : !entry.isDirectory())
    )
      throw new Error(
        "invoked Claude repository skill is unavailable or unsafe",
      );
  }
  return {
    skillName,
    skillDir: join(path, ".."),
    skillText: await readFile(path, "utf8"),
    prompt: request.prompt,
  };
}

/** Match one exact command and complete body before the assistant starts. */
export function matchClaudeRepositoryInvocation(
  input: ClaudeRepositoryInvocation & {
    transcript: string;
    sessionId: string;
  },
): { accepted: boolean | null; reason: string } {
  let native: Entry[];
  try {
    native = entries(input.transcript);
  } catch {
    return { accepted: null, reason: "malformed native session" };
  }
  const firstAssistant = native.findIndex(
    (entry) => entry.type === "assistant",
  );
  if (firstAssistant < 0)
    return { accepted: null, reason: "missing assistant turn" };
  const assistant = native[firstAssistant]!;
  if (assistant.sessionId !== input.sessionId || assistant.isSidechain === true)
    return { accepted: false, reason: "assistant session differs" };
  const before = native.slice(0, firstAssistant);
  const token = `/${input.skillName}`;
  if (
    input.prompt !== token &&
    !input.prompt.startsWith(token + " ") &&
    !input.prompt.startsWith(token + "\n")
  )
    return { accepted: false, reason: "prompt differs from mounted command" };
  const args = input.prompt.slice(token.length).trim();
  const command =
    `<command-message>${input.skillName}</command-message>\n<command-name>${token}</command-name>` +
    (args ? `\n<command-args>${args}</command-args>` : "");
  const commands = before.filter(
    (entry) =>
      entry.type === "user" &&
      content(entry).includes(`<command-name>${token}</command-name>`),
  );
  if (commands.length !== 1)
    return { accepted: false, reason: "missing or duplicate native command" };
  const called = commands[0]!;
  if (
    called.sessionId !== input.sessionId ||
    called.isMeta === true ||
    called.isSidechain === true ||
    content(called) !== command
  )
    return { accepted: false, reason: "command session or arguments differ" };
  const body = input.skillText
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .trim();
  if (!body) return { accepted: null, reason: "empty mounted body" };
  const prefix = `Base directory for this skill: ${input.skillDir}\n\n${body}`;
  const expanded = before.filter(
    (entry) =>
      entry.type === "user" &&
      (content(entry) === prefix || content(entry).startsWith(prefix + "\n")),
  );
  if (expanded.length !== 1)
    return {
      accepted: false,
      reason: "missing, partial, or duplicate mounted body",
    };
  const loaded = expanded[0]!;
  if (
    loaded.sessionId !== input.sessionId ||
    loaded.isMeta !== true ||
    loaded.isSidechain === true ||
    before.indexOf(loaded) <= before.indexOf(called)
  )
    return { accepted: false, reason: "mounted body is uncorrelated" };
  return {
    accepted: true,
    reason: "native command and complete mounted body matched",
  };
}

/** Read only the completed bound native session; retain no arguments or body. */
export async function claudeRepositoryInvocationObservation(input: {
  invocation: ClaudeRepositoryInvocation;
  stream: string;
  configRoot: string;
  workspace: string;
  tools: ClaudeToolCallsObservation;
}) {
  let receipt: { accepted: boolean | null; reason: string } = {
    accepted: null,
    reason: "native session evidence unavailable",
  };
  try {
    const sessions = [
      ...new Set(
        entries(input.stream)
          .filter(
            (entry) =>
              entry.type === "result" ||
              (entry.type === "system" && entry.subtype === "init"),
          )
          .map((entry) => entry.session_id),
      ),
    ];
    if (
      sessions.length === 1 &&
      typeof sessions[0] === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(sessions[0])
    ) {
      const workspace = await realpath(input.workspace);
      const path = join(
        await realpath(input.configRoot),
        "projects",
        workspace.replace(/[^A-Za-z0-9]/g, "-"),
        `${sessions[0]}.jsonl`,
      );
      const entry = await lstat(path);
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.size <= 8 * 1024 * 1024 &&
        (await realpath(path)) === path
      ) {
        receipt = matchClaudeRepositoryInvocation({
          ...input.invocation,
          sessionId: sessions[0],
          transcript: await readFile(path, "utf8"),
        });
      }
    }
  } catch {
    /* Unavailable or malformed native evidence stays partial. */
  }
  const observed = input.tools.data.calls
    .filter((call) => call.name === "Skill")
    .map((call) => call.skill);
  const observedSkills = [
    ...new Set([
      ...(receipt.accepted === true ? [input.invocation.skillName] : []),
      ...observed,
    ]),
  ];
  return {
    id: "sevro.claude.repository-invocation" as const,
    completeness:
      receipt.accepted === true && input.tools.completeness === "complete"
        ? ("complete" as const)
        : ("partial" as const),
    data: {
      method: "native_repository_command",
      ...receipt,
      skill: input.invocation.skillName,
      primarySkill: observedSkills[0] ?? null,
      observedSkills,
    },
  };
}
