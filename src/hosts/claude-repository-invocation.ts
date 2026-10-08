import type { Stats } from "node:fs";
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
  requireRepositorySelection(selected);
  const { skillName, token } = selected;
  if (!validRepositoryDeclaration(skillName, token, request.prompt))
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
    if (!safeSkillEntry(entry, index))
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

function requireRepositorySelection(
  selected: Parameters<HostAdapter["run"]>[0]["explicitSkillInvocation"],
): asserts selected is Extract<
  NonNullable<Parameters<HostAdapter["run"]>[0]["explicitSkillInvocation"]>,
  { scope: "repository" }
> {
  if (!selected || selected.scope !== "repository")
    throw new Error("Claude repository invocation is not declared");
}

type Receipt = { accepted: boolean | null; reason: string };
type MatchInput = ClaudeRepositoryInvocation & {
  transcript: string;
  sessionId: string;
};
type AssistantBoundary = { before: Entry[] } | { receipt: Receipt };
type CommandBoundary = { called: Entry } | { receipt: Receipt };

function validRepositoryDeclaration(
  skillName: string,
  token: string,
  prompt: string,
): boolean {
  return (
    validRepositorySkillName(skillName) &&
    token === `/${skillName}` &&
    prompt.split(token).length - 1 === 1 &&
    repositoryPromptMatches(prompt, token)
  );
}
function validRepositorySkillName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && ![".", ".."].includes(name);
}
function repositoryPromptMatches(prompt: string, token: string): boolean {
  return (
    prompt === token ||
    prompt.startsWith(token + " ") ||
    prompt.startsWith(token + "\n")
  );
}
function safeSkillEntry(entry: Stats | null, index: number): boolean {
  if (!entry || entry.isSymbolicLink()) return false;
  return index === 3
    ? entry.isFile() && entry.size <= 1024 * 1024
    : entry.isDirectory();
}

/** Match one exact command and complete body before the assistant starts. */
export function matchClaudeRepositoryInvocation(input: MatchInput): Receipt {
  let native: Entry[];
  try {
    native = entries(input.transcript);
  } catch {
    return { accepted: null, reason: "malformed native session" };
  }
  const boundary = assistantBoundary(native, input.sessionId);
  if ("receipt" in boundary) return boundary.receipt;
  return matchCommandAndBody(boundary.before, input);
}

function assistantBoundary(
  native: Entry[],
  sessionId: string,
): AssistantBoundary {
  const firstAssistant = native.findIndex(
    (entry) => entry.type === "assistant",
  );
  const assistant = native.at(firstAssistant);
  if (firstAssistant < 0 || assistant === undefined)
    return { receipt: { accepted: null, reason: "missing assistant turn" } };
  if (assistant.sessionId !== sessionId || assistant.isSidechain === true)
    return {
      receipt: { accepted: false, reason: "assistant session differs" },
    };
  return { before: native.slice(0, firstAssistant) };
}

function nativeCommand(input: MatchInput, token: string): string {
  const args = input.prompt.slice(token.length).trim();
  return (
    `<command-message>${input.skillName}</command-message>\n<command-name>${token}</command-name>` +
    (args ? `\n<command-args>${args}</command-args>` : "")
  );
}

function matchCommandAndBody(before: Entry[], input: MatchInput): Receipt {
  const token = `/${input.skillName}`;
  if (!repositoryPromptMatches(input.prompt, token))
    return { accepted: false, reason: "prompt differs from mounted command" };
  const command = commandBoundary(before, input, token);
  if ("receipt" in command) return command.receipt;
  return mountedBodyReceipt(before, input, command.called);
}

function commandBoundary(
  before: Entry[],
  input: MatchInput,
  token: string,
): CommandBoundary {
  const commands = before.filter(
    (entry) =>
      entry.type === "user" &&
      content(entry).includes(`<command-name>${token}</command-name>`),
  );
  const [called] = commands;
  if (commands.length !== 1 || called === undefined)
    return {
      receipt: {
        accepted: false,
        reason: "missing or duplicate native command",
      },
    };
  if (!commandCorrelated(called, input, nativeCommand(input, token)))
    return {
      receipt: {
        accepted: false,
        reason: "command session or arguments differ",
      },
    };
  return { called };
}

function commandCorrelated(
  called: Entry,
  input: MatchInput,
  command: string,
): boolean {
  return (
    called.sessionId === input.sessionId &&
    called.isMeta !== true &&
    called.isSidechain !== true &&
    content(called) === command
  );
}

function mountedBodyReceipt(
  before: Entry[],
  input: MatchInput,
  called: Entry,
): Receipt {
  const body = input.skillText
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .trim();
  if (!body) return { accepted: null, reason: "empty mounted body" };
  const prefix = `Base directory for this skill: ${input.skillDir}\n\n${body}`;
  const expanded = before.filter((entry) => mountedBodyMatches(entry, prefix));
  const [loaded] = expanded;
  if (expanded.length !== 1 || loaded === undefined)
    return {
      accepted: false,
      reason: "missing, partial, or duplicate mounted body",
    };
  if (!bodyCorrelated(loaded, input.sessionId, before, called))
    return { accepted: false, reason: "mounted body is uncorrelated" };
  return {
    accepted: true,
    reason: "native command and complete mounted body matched",
  };
}

function mountedBodyMatches(entry: Entry, prefix: string): boolean {
  return (
    entry.type === "user" &&
    (content(entry) === prefix || content(entry).startsWith(prefix + "\n"))
  );
}

function bodyCorrelated(
  loaded: Entry,
  sessionId: string,
  before: Entry[],
  called: Entry,
): boolean {
  return (
    loaded.sessionId === sessionId &&
    loaded.isMeta === true &&
    loaded.isSidechain !== true &&
    before.indexOf(loaded) > before.indexOf(called)
  );
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
    receipt = await repositoryReceipt(input);
  } catch {
    /* Unavailable or malformed native evidence stays partial. */
  }
  const observed = input.tools.data.calls
    .filter((call) => call.name === "Skill")
    .map((call) => call.skill);
  const observedSkills = repositoryObservedSkills(
    receipt,
    input.invocation.skillName,
    observed,
  );
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

function repositoryObservedSkills(
  receipt: Receipt,
  skillName: string,
  observed: string[],
): string[] {
  return [
    ...new Set([
      ...(receipt.accepted === true ? [skillName] : []),
      ...observed,
    ]),
  ];
}

function repositorySessionId(stream: string): string | null {
  const sessions = [
    ...new Set(
      entries(stream)
        .filter(
          (entry) =>
            entry.type === "result" ||
            (entry.type === "system" && entry.subtype === "init"),
        )
        .map((entry) => entry.session_id),
    ),
  ];
  const [id] = sessions;
  if (
    sessions.length !== 1 ||
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(id)
  )
    return null;
  return id;
}

async function repositoryReceipt(
  input: Parameters<typeof claudeRepositoryInvocationObservation>[0],
): Promise<Receipt> {
  const sessionId = repositorySessionId(input.stream);
  if (sessionId === null)
    return { accepted: null, reason: "native session evidence unavailable" };
  const workspace = await realpath(input.workspace);
  const path = join(
    await realpath(input.configRoot),
    "projects",
    workspace.replace(/[^A-Za-z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  );
  const entry = await lstat(path);
  if (!regularTranscript(entry) || (await realpath(path)) !== path)
    return { accepted: null, reason: "native session evidence unavailable" };
  return matchClaudeRepositoryInvocation({
    ...input.invocation,
    sessionId,
    transcript: await readFile(path, "utf8"),
  });
}

function regularTranscript(entry: Stats): boolean {
  return (
    entry.isFile() && !entry.isSymbolicLink() && entry.size <= 8 * 1024 * 1024
  );
}
