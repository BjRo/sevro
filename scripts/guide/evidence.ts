import { parse as parseShell } from "shell-quote";
import { isRecord, isUnknownArray } from "../../src/value-guards";

export type GuideEvent = Record<string, unknown>;
export type Turn = { answer: string; events: GuideEvent[] };
type ShellTokens = ReturnType<typeof parseShell>;
const sourcePattern =
  /(?:docs\/[a-z0-9_./-]+\.md|README\.md|CONTRIBUTING\.md|LICENSE|package\.json|src\/[a-z0-9_./-]+\.ts)/g;

function programName(value: string | undefined): string {
  return value?.split("/").at(-1) ?? "";
}
function word(token: ShellTokens[number]): string | undefined {
  if (typeof token === "string") return token;
  if (!("op" in token) || token.op !== "glob") return undefined;
  return /^[A-Za-z0-9_./]/.test(token.pattern) ? token.pattern : undefined;
}
function separator(token: ShellTokens[number]): boolean {
  return (
    typeof token !== "string" &&
    "op" in token &&
    ["&&", ";", "|"].includes(token.op)
  );
}
function segments(tokens: ShellTokens): string[][] | null {
  const result: string[][] = [],
    current: string[] = [];
  for (const token of tokens) {
    const literal = word(token);
    if (literal !== undefined) current.push(literal);
    else if (separator(token)) result.push(current.splice(0));
    else return null;
  }
  result.push(current);
  return result.filter((part) => part.length);
}
function shellPayload(words: string[]): string | undefined {
  if (words.length !== 3) return undefined;
  if (!["sh", "bash", "zsh"].includes(programName(words[0]))) return undefined;
  return ["-c", "-lc"].includes(words[1] ?? "") ? words[2] : undefined;
}
function readonlySegment([program, ...args]: string[]): boolean {
  const name = programName(program);
  if (
    ["pwd", "cat", "ls", "head", "tail", "nl", "wc", "echo", "printf"].includes(
      name,
    )
  )
    return true;
  if (name === "sed") return readonlySed(args);
  return (
    ["rg", "grep"].includes(name) &&
    !args.some((arg) =>
      /^(?:--pre|--hostname-bin|--hyperlink-format)(?:=|$)/.test(arg),
    )
  );
}
function readonlySed(args: string[]): boolean {
  return (
    args[0] === "-n" && /^\d+(?:,\d+)?p(?:;\d+(?:,\d+)?p)*$/.test(args[1] ?? "")
  );
}

function readCommands(command: string, depth: number): string[][] | null {
  if (depth > 2 || /\$\(|\x60/.test(command)) return null;
  try {
    const parts = segments(parseShell(command));
    return hasCommands(parts) ? validatedCommands(parts, depth) : null;
  } catch {
    return null;
  }
}
function hasCommands(parts: string[][] | null): parts is string[][] {
  return parts !== null && parts.length > 0;
}
function validatedCommands(
  parts: string[][],
  depth: number,
): string[][] | null {
  const payload = parts.length === 1 ? shellPayload(parts[0] ?? []) : undefined;
  if (payload !== undefined) return readCommands(payload, depth + 1);
  return parts.every(readonlySegment) ? parts : null;
}
export function readOnlyCommand(command: string): boolean {
  return readCommands(command, 0) !== null;
}
function contentSegment([program, ...args]: string[]): boolean {
  const name = programName(program);
  if (["cat", "head", "tail", "nl", "sed"].includes(name)) return true;
  return (
    ["rg", "grep"].includes(name) &&
    !args.some((arg) =>
      /^-[A-Za-z]*[clL][A-Za-z]*$|^(?:--files|--files-with-matches|--files-without-match|--count|--count-matches)(?:=|$)/.test(
        arg,
      ),
    )
  );
}
function blocks(event: GuideEvent): GuideEvent[] {
  const content = isRecord(event.message) ? event.message.content : undefined;
  if (!isUnknownArray(content)) return [];
  if (content.includes(null)) throw new Error("Invalid native content block");
  return content.filter(isRecord);
}
function toolText(turn: Turn, id: unknown): string {
  return turn.events
    .flatMap(blocks)
    .filter(
      (block) =>
        block.type === "tool_result" &&
        block.tool_use_id === id &&
        block.is_error !== true,
    )
    .map((block) => contentText(block.content))
    .join("\n");
}
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isUnknownArray(value)) return "";
  return value
    .filter(isRecord)
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n");
}
function toolResult(turn: Turn, id: unknown): boolean {
  if (!id) return false;
  return turn.events
    .flatMap(blocks)
    .some(
      (block) =>
        block.type === "tool_result" &&
        block.tool_use_id === id &&
        block.is_error !== true,
    );
}

// Claude's native Skill-call observation does not include direct Read results.
export function usedGuide(turn: Turn, guideText: string): boolean {
  return turn.events.flatMap(blocks).some((block) => {
    if (block.type !== "tool_use" || !toolResult(turn, block.id)) return false;
    const input = isRecord(block.input) ? block.input : {};
    if (block.name === "Skill") return input.skill === "sevro-guide";
    return mountedGuideRead(block, input, toolText(turn, block.id), guideText);
  });
}
function mountedGuideRead(
  block: GuideEvent,
  input: GuideEvent,
  text: string,
  guideText: string,
) {
  if (block.name !== "Read" || typeof input.file_path !== "string")
    return false;
  if (!guideText) return false;
  if (
    !/\/(?:\.agents|\.claude)\/skills\/sevro-guide\/SKILL\.md$/.test(
      input.file_path,
    )
  )
    return false;
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^\s*\d+(?:→|\t)/gm, "")
    .includes(guideText);
}

function commandSources(item: GuideEvent): string[] {
  if (!completedRead(item)) return [];
  const result = commandText(item);
  return result ? commandReferences(result.command, result.output) : [];
}
function commandText(item: GuideEvent) {
  if (
    typeof item.command !== "string" ||
    typeof item.aggregated_output !== "string"
  )
    return undefined;
  if (!item.aggregated_output.trim()) return undefined;
  return { command: item.command, output: item.aggregated_output };
}
function commandReferences(command: string, output: string): string[] {
  return (readCommands(command, 0) ?? [])
    .filter(contentSegment)
    .flatMap((args) => {
      const name = programName(args[0]);
      if (["rg", "grep"].includes(name))
        return [
          ...output.matchAll(
            /^(docs\/[a-z0-9_./-]+\.md|README\.md|CONTRIBUTING\.md|LICENSE|package\.json|src\/[a-z0-9_./-]+\.ts)(?::\d+)?[:-].+/gm,
          ),
        ].map((match) => match[1] ?? "");
      return sourceMatches(args.slice(name === "sed" ? 3 : 1).join(" "));
    });
}
function completedRead(item: GuideEvent): boolean {
  return item.type === "command_execution" && item.exit_code === 0;
}
function toolSources(block: GuideEvent, turn: Turn): string[] {
  if (block.type !== "tool_use" || !toolText(turn, block.id).trim()) return [];
  const input = isRecord(block.input) ? block.input : {};
  return namedToolSources(block.name, input, toolText(turn, block.id));
}

function namedToolSources(
  name: unknown,
  input: GuideEvent,
  text: string,
): string[] {
  if (name === "Read" && typeof input.file_path === "string")
    return sourceMatches(input.file_path);
  if (name === "Grep" && input.output_mode === "content")
    return sourceMatches(text);
  return [];
}
function sourceMatches(text: string): string[] {
  return text.match(sourcePattern) ?? [];
}
export function inspectedSources(turn: Turn): string[] {
  return [
    ...new Set(
      turn.events.flatMap((event) => [
        ...(event.type === "item.completed" && isRecord(event.item)
          ? commandSources(event.item)
          : []),
        ...blocks(event).flatMap((block) => toolSources(block, turn)),
      ]),
    ),
  ];
}

function itemEffects(item: unknown): string[] {
  if (!isRecord(item)) return item ? ["unknown item"] : [];
  if (item.type === "command_execution") return commandEffects(item.command);
  return ["agent_message", "reasoning", "todo_list"].includes(String(item.type))
    ? []
    : [String(item.type)];
}
function commandEffects(command: unknown): string[] {
  if (typeof command !== "string") return ["unknown command"];
  return readOnlyCommand(command) ? [] : [command];
}
function toolEffects(block: GuideEvent): string[] {
  if (block.type !== "tool_use") return [];
  if (["Read", "Glob", "Grep", "Skill"].includes(String(block.name))) return [];
  return [typeof block.name === "string" ? block.name : "unknown tool"];
}
export function effectAttempts(turn: Turn): string[] {
  return turn.events.flatMap((event) => [
    ...itemEffects(event.item),
    ...blocks(event).flatMap(toolEffects),
  ]);
}
