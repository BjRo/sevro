import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isRecord, isUnknownArray } from "../../src/value-guards";
import { contentCommands, programName, readOnlyCommand } from "./commands";
import type { GuideEvent, Turn } from "./types";

const guideText = (
  await readFile(
    resolve(import.meta.dir, "../../.agents/skills/sevro-guide/SKILL.md"),
    "utf8",
  )
).trim();
const sourcePattern =
  /(?:docs\/[a-z0-9_./-]+\.md|README\.md|CONTRIBUTING\.md|LICENSE|package\.json|src\/[a-z0-9_./-]+\.ts)/g;

export function blocks(event: GuideEvent): GuideEvent[] {
  const message = isRecord(event.message) ? event.message : undefined;
  const content = message?.content;
  if (!isUnknownArray(content)) return [];
  if (content.some((value) => value === null))
    throw new Error("Invalid native content block");
  return content.filter(isRecord);
}

function inputField(block: GuideEvent, key: string): unknown {
  return isRecord(block.input) ? block.input[key] : undefined;
}

function textPart(part: unknown): string {
  if (part === null || part === undefined)
    throw new Error("Invalid native result part");
  if (!isRecord(part)) return "";
  return nativeLabel(part.text ?? "");
}

// Native events are JSON: retain their scalar/default object display semantics.
function nativeLabel(value: unknown): string {
  if (isUnknownArray(value)) return value.map(arrayLabel).join(",");
  if (isRecord(value)) return Object.prototype.toString.call(value);
  return String(value);
}
function arrayLabel(value: unknown): string {
  return value === null || value === undefined ? "" : nativeLabel(value);
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  return isUnknownArray(content) ? content.map(textPart).join("\n") : "";
}

function successfulResult(block: GuideEvent, id: unknown): boolean {
  return (
    block.type === "tool_result" &&
    block.tool_use_id === id &&
    block.is_error !== true
  );
}

function resultText(turn: Turn, id: unknown): string {
  return turn.events
    .flatMap(blocks)
    .filter((block) => successfulResult(block, id))
    .map((block) => blockText(block.content))
    .join("\n");
}

function successfulTool(turn: Turn, id: unknown): boolean {
  return Boolean(
    id &&
    turn.events.some((event) =>
      blocks(event).some((block) => successfulResult(block, id)),
    ),
  );
}

function completeGuide(text: unknown): boolean {
  return (
    typeof text === "string" &&
    text
      .replace(/\r\n/g, "\n")
      .replace(/^\s*\d+(?:→|\t)/gm, "")
      .includes(guideText)
  );
}

type CommandItem = GuideEvent & {
  type: "command_execution";
  exit_code: 0;
  command: string;
};
function successfulCommand(value: unknown): value is CommandItem {
  if (!isRecord(value)) return false;
  return (
    value.type === "command_execution" &&
    value.exit_code === 0 &&
    typeof value.command === "string"
  );
}

function completedCommand(event: GuideEvent): CommandItem | null {
  if (event.type !== "item.completed") return null;
  return successfulCommand(event.item) ? event.item : null;
}

function guideReadSegment([program, ...args]: string[]): boolean {
  return (
    ["cat", "sed", "head", "tail", "nl"].includes(programName(program)) &&
    args.some((argument) =>
      /(?:^|\/)(?:\.agents|\.claude)\/skills\/sevro-guide\/SKILL\.md$/.test(
        argument,
      ),
    )
  );
}

function codexGuideRead(event: GuideEvent): boolean {
  const item = completedCommand(event);
  if (!item) return false;
  return (
    contentCommands(item.command).some(guideReadSegment) &&
    completeGuide(item.aggregated_output)
  );
}

function skillInvocation(block: GuideEvent): boolean {
  return block.name === "Skill" && inputField(block, "skill") === "sevro-guide";
}

function guideFileRead(block: GuideEvent, turn: Turn): boolean {
  if (block.name !== "Read") return false;
  const path = inputField(block, "file_path");
  if (typeof path !== "string") return false;
  return (
    completeGuide(resultText(turn, block.id)) &&
    /\/(?:\.agents|\.claude)\/skills\/sevro-guide\/SKILL\.md$/.test(path)
  );
}

function claudeGuideRead(block: GuideEvent, turn: Turn): boolean {
  if (block.type !== "tool_use" || !successfulTool(turn, block.id))
    return false;
  return skillInvocation(block) || guideFileRead(block, turn);
}

export function usedGuide(turn: Turn): boolean {
  for (const event of turn.events) {
    if (codexGuideRead(event)) return true;
    for (const block of blocks(event))
      if (claudeGuideRead(block, turn)) return true;
  }
  return false;
}

function grepSources(output: string): string[] {
  return [
    ...output.matchAll(
      /^(docs\/[a-z0-9_./-]+\.md|README\.md|CONTRIBUTING\.md|LICENSE|package\.json|src\/[a-z0-9_./-]+\.ts)(?::\d+)?[:-].+/gm,
    ),
  ].map((match) => match[1] ?? "");
}

function commandSources(item: CommandItem): string[] {
  const output = item.aggregated_output;
  if (typeof output !== "string" || !output.trim()) return [];
  return contentCommands(item.command).flatMap((args) => {
    const name = programName(args[0]);
    if (["rg", "grep"].includes(name)) return grepSources(output);
    return (
      args
        .slice(name === "sed" ? 3 : 1)
        .join(" ")
        .match(sourcePattern) ?? []
    );
  });
}

function namedTool(block: GuideEvent, names: string[]): boolean {
  return typeof block.name === "string" && names.includes(block.name);
}

function successfulSourceTool(block: GuideEvent, turn: Turn): boolean {
  return (
    block.type === "tool_use" &&
    namedTool(block, ["Read", "Grep"]) &&
    successfulTool(turn, block.id) &&
    Boolean(resultText(turn, block.id).trim())
  );
}

function serializedContent(value: unknown): string {
  if (value === undefined)
    throw new Error("Native result content is unavailable");
  return JSON.stringify(value);
}

function grepToolSources(block: GuideEvent, turn: Turn): string[] {
  if (block.name !== "Grep" || inputField(block, "output_mode") !== "content")
    return [];
  return turn.events
    .flatMap(blocks)
    .filter((result) => result.tool_use_id === block.id)
    .flatMap(
      (result) => serializedContent(result.content).match(sourcePattern) ?? [],
    );
}

function toolSources(block: GuideEvent, turn: Turn): string[] {
  if (!successfulSourceTool(block, turn)) return [];
  const path = inputField(block, "file_path");
  if (block.name === "Read" && typeof path === "string")
    return path.match(sourcePattern) ?? [];
  return grepToolSources(block, turn);
}

export function inspectedSources(turn: Turn): string[] {
  return [
    ...new Set(turn.events.flatMap((event) => eventSources(event, turn))),
  ];
}
function eventSources(event: GuideEvent, turn: Turn): string[] {
  const item = completedCommand(event),
    sources = item ? commandSources(item) : [];
  for (const block of blocks(event)) sources.push(...toolSources(block, turn));
  return sources;
}

export function citedInspection(turn: Turn): boolean {
  return inspectedSources(turn).some((source) => turn.answer.includes(source));
}

function itemEffects(item: unknown): string[] {
  return [
    ...commandEffect(isRecord(item) ? item : undefined),
    ...unknownItemEffect(item),
  ];
}
function commandEffect(item: GuideEvent | undefined): string[] {
  if (item?.type !== "command_execution") return [];
  if (typeof item.command !== "string") return [];
  return readOnlyCommand(item.command) ? [] : [item.command];
}
function unknownItemEffect(item: unknown): string[] {
  if (!item) return [];
  const type = isRecord(item) ? item.type : undefined;
  return [
    "command_execution",
    "agent_message",
    "reasoning",
    "todo_list",
  ].includes(String(type))
    ? []
    : [String(type)];
}

function toolEffect(block: GuideEvent): string[] {
  if (
    block.type !== "tool_use" ||
    namedTool(block, ["Read", "Glob", "Grep", "Skill"])
  )
    return [];
  const name = block.name ?? "unknown tool";
  return [nativeLabel(name)];
}

export function effectAttempts(turn: Turn): string[] {
  return turn.events.flatMap((event) => [
    ...itemEffects(event.item),
    ...blocks(event).flatMap(toolEffect),
  ]);
}
