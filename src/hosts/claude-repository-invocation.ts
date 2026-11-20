import type { ClaudeRepositoryInvocation } from "./claude-invocation";
import type { ClaudeNativeSession } from "./claude-native-session";
import { isRecord } from "../kernel/index";
import {
  parseClaudeEvents,
  type ClaudeEvents,
  type ClaudeToolCallsObservation,
} from "../host-events/index";

type Entry = Record<string, unknown>;
function entries(text: string | ClaudeEvents): Entry[] {
  return parseClaudeEvents(text).lines.map((line) => {
    if (!line.parsed) throw line.error;
    if (!isRecord(line.value)) throw new Error("invalid Claude session entry");
    return line.value;
  });
}

function content(entry: Entry): string {
  const blocks = isRecord(entry.message) ? entry.message.content : null;
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter(isRecord)
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

type Receipt = { accepted: boolean | null; reason: string };
type MatchInput = ClaudeRepositoryInvocation & {
  transcript: string;
  sessionId: string;
};
type AssistantBoundary = { before: Entry[] } | { receipt: Receipt };
type CommandBoundary = { called: Entry } | { receipt: Receipt };

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

/** The verified declaration already requires the prompt to lead with `token`. */
function matchCommandAndBody(before: Entry[], input: MatchInput): Receipt {
  const token = `/${input.skillName}`;
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
  session: ClaudeNativeSession;
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
    },
  };
}

async function repositoryReceipt(
  input: Parameters<typeof claudeRepositoryInvocationObservation>[0],
): Promise<Receipt> {
  if (!input.session.initialBound)
    return { accepted: null, reason: "native session evidence unavailable" };
  return matchClaudeRepositoryInvocation({
    ...input.invocation,
    sessionId: input.session.id,
    transcript: await input.session.transcript(),
  });
}
