import { isRecord, isUnknownArray } from "../value-guards";
import type {
  RecoveredCommandOutput,
  RecoveredSkillRead,
} from "./codex-command-output";
import {
  nativeCommandOutputs,
  normalizedCommandCwd,
  untruncatedCommandOutput,
} from "./codex-command-output";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_NATIVE_READ_ATTEMPTS = 64;
const SKILL_PATH = /^\.agents\/skills\/([A-Za-z0-9._-]+)\/SKILL\.md$/;
const PLUGIN_SKILL_PATH = /^skills\/([A-Za-z0-9._-]+)\/SKILL\.md$/;

interface CodexItem {
  cwd?: unknown;
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
  if (!literalReadPath(sed, 3)) return null;
  const firstLine = Number(sed[1]),
    lastLine = Number(sed[2]);
  if (!validReadLines(firstLine, lastLine)) return null;
  return { path: capturedReadPath(sed, 3), firstLine, lastLine };
}
function directRead(command: string): DirectRead | null {
  const shell = shellPayload(command).trim();
  const payload = compoundReadPayload(shell);
  const path = "(?:\"([^\"]+)\"|'([^']+)'|([^\\s'\"`$;&|<>]+))";
  return sedRead(payload, path) ?? fallbackRead(payload, path);
}

const LITERAL_WORD = "(?:\"[^\"$`\\\\]*\"|'[^']*'|[^\\s\"'\\\\`$;&|<>(){}#]+)";
const LITERAL_WORDS = `${LITERAL_WORD}(?:[ \\t]+${LITERAL_WORD})*`;
const SEQUENTIAL_WORD =
  "(?:\"[^\"$`\\\\]*\"|'[^']*'|[^\\s\"'\\\\`$;&|<>(){}#*?\\[\\]~]+)";
const SEQUENTIAL_WORDS = `${SEQUENTIAL_WORD}(?:[ \\t]+${SEQUENTIAL_WORD})*`;

// Recognize only literal commands; quoted separators remain part of their word.
function literalCommands(payload: string): string[] | null {
  const clause = new RegExp(
    `[ \\t\\r\\n]*(${SEQUENTIAL_WORDS})[ \\t]*(?:[;\\n]|$)`,
    "gy",
  );
  const commands: string[] = [];
  while (clause.lastIndex < payload.length) {
    const match = clause.exec(payload);
    if (!match || commands.length > MAX_NATIVE_READ_ATTEMPTS) return null;
    commands.push(match.slice(1, 2).join(""));
  }
  return commands;
}

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
    !reads.every(singleFallbackRead)
  )
    return null;
  const paths = reads.map((read) => read.path);
  return { path: paths.slice(0, 1).join(""), fallbackPaths: paths.slice(1) };
}

function singleFallbackRead(read: DirectRead | null): read is DirectRead {
  return read !== null && read.operandCount === 1;
}

function fallbackOperandCount(reads: Array<DirectRead | null>): number {
  return reads.reduce((count, read) => count + (read?.operandCount ?? 0), 0);
}

function unsupportedCatOptions(payload: string, paths: string[]): boolean {
  if (/^(?:\/bin\/)?cat\s+--\s/.test(payload)) return false;
  return paths.some((path) => path.startsWith("-"));
}

function catOperands(payload: string, path: string): string[] | null {
  const cat = payload.match(
    new RegExp(`^(?:/bin/)?cat\\s+(?:--\\s+)?(${path}(?:\\s+${path})*)$`),
  );
  if (!cat) return null;
  const operands = [
    ...cat.slice(1, 2).join("").matchAll(new RegExp(path, "g")),
  ];
  if (!operands.every((match) => literalReadPath(match, 1))) return null;
  const paths = operands.map((match) => capturedReadPath(match, 1));
  return unsupportedCatOptions(payload, paths) ? null : paths;
}

function literalReadPath(match: RegExpMatchArray, first: number): boolean {
  const path = capturedReadPath(match, first);
  if (match[first] !== undefined) return !/[$`\\]/.test(path);
  if (match[first + 1] !== undefined) return true;
  return !/[\\*?[\]~(){}#]/.test(path);
}

function catRead(payload: string, path: string): DirectRead | null {
  const paths = catOperands(payload, path);
  if (!paths) return null;
  const skills = paths.filter((value) => /(?:^|\/)SKILL\.md$/.test(value));
  if (skills.length !== 1 || paths.length > MAX_NATIVE_READ_ATTEMPTS)
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
): Promise<VerifiedRead[]> {
  if (!untruncatedCommandOutput(nativeOutput(item))) return [];
  return verifiedUntruncatedSkillRead(item, workspace, pluginRoots, commandCwd);
}

async function verifiedUntruncatedSkillRead(
  item: CodexItem,
  workspace: string,
  pluginRoots: string[],
  commandCwd: string,
): Promise<VerifiedRead[]> {
  const composed = await composedSkillReads(
    item,
    workspace,
    pluginRoots,
    commandCwd,
  );
  if (composed !== null) return composed;
  const declaration = readDeclaration(item);
  if (!declaration) return [];
  const read = await resolvedSkillRead(
    declaration,
    workspace,
    pluginRoots,
    commandCwd,
  );
  return read ? [read] : [];
}

interface ComposedPlan {
  paths: string[];
  prefixed: boolean;
  suffix: "none" | "search" | "discovery";
  singleCat: boolean;
}

function normalizedReadPayload(command: string) {
  const shell = shellPayload(command).trim();
  const firstRead = shell.search(/(?:^|[;\n])[ \t]*(?:\/bin\/)?cat\s/);
  if (firstRead < 0) return { payload: shell, relocated: false };
  const prefix = shell.slice(0, firstRead);
  const repository =
    /(^|[;\n])[ \t]*repo=\$\(git -C "\$PWD" rev-parse --show-toplevel\)[ \t]*[;\n][ \t]*cd "\$repo" && pwd -P(?=[;\n]|$)/g;
  const relocated = repository.test(prefix);
  repository.lastIndex = 0;
  const payload = prefix
    .replace(repository, "$1pwd -P")
    .replace(
      /(^|[;\n])[ \t]*git -C "\$PWD" rev-parse --show-toplevel(?=[;\n]|$)/g,
      "$1git rev-parse --show-toplevel",
    );
  return { payload: payload + shell.slice(firstRead), relocated };
}

function composedPlan(command: string): ComposedPlan | null {
  const normalized = normalizedReadPayload(command);
  const commands = literalCommands(normalized.payload);
  if (!commands) return null;
  const plan = composedCommandPlan(commands);
  if (!plan) return null;
  if (normalized.relocated && !plan.paths.every(isAbsolute)) return null;
  return plan;
}

function composedCommandPlan(commands: string[]): ComposedPlan | null {
  const first = commands.findIndex((command) =>
    /^(?:\/bin\/)?cat\s/.test(command),
  );
  if (first < 0 || !commands.slice(0, first).every(readPrefix)) return null;
  const last =
    commands.length -
    1 -
    [...commands]
      .reverse()
      .findIndex((command) => /^(?:\/bin\/)?cat\s/.test(command));
  const suffix = boundReadSuffix(
    commands.slice(0, first),
    commands.slice(last + 1),
  );
  if (suffix === null) return null;
  const paths = composedOperands(commands.slice(first, last + 1));
  return paths
    ? { paths, prefixed: first > 0, suffix, singleCat: commands.length === 1 }
    : null;
}

function boundReadSuffix(
  prefixes: string[],
  commands: string[],
): ComposedPlan["suffix"] | null {
  const suffix = readSuffix(commands);
  if (suffix === "none") return suffix;
  return prefixes.some((command) =>
    /^(?:\/usr\/bin\/)?printenv\s/.test(command),
  )
    ? null
    : suffix;
}

function composedOperands(commands: string[]): string[] | null {
  const path = "(?:\"([^\"]+)\"|'([^']+)'|([^\\s'\"`$;&|<>]+))";
  const operands = commands.map((command) => catOperands(command, path));
  if (!operands.every((paths): paths is string[] => paths !== null))
    return null;
  const paths = operands.flat();
  return paths.length <= MAX_NATIVE_READ_ATTEMPTS ? paths : null;
}

function readSuffix(commands: string[]): ComposedPlan["suffix"] | null {
  if (commands.length === 0) return "none";
  if (commands.every(readPrefix)) return "discovery";
  return commands.every((command) =>
    new RegExp(`^(?:/usr/bin/)?rg\\s+${LITERAL_WORDS}$`).test(command),
  )
    ? "search"
    : null;
}

function readPrefix(command: string): boolean {
  return [
    /^(?:unset|(?:\/usr\/bin\/)?printenv)\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*$/,
    /^(?:\/bin\/)?pwd(?:\s+-P)?$/,
    /^(?:\/usr\/bin\/)?git\s+rev-parse\s+--show-toplevel$/,
    /^(?:\/usr\/bin\/)?git\s+(?:status\s+--short|diff\s+--stat)$/,
    new RegExp(`^(?:/usr/bin/)?rg\\s+--files(?:\\s+${LITERAL_WORDS})?$`),
  ].some((pattern) => pattern.test(command));
}

async function composedSkillReads(
  item: CodexItem,
  workspace: string,
  pluginRoots: string[],
  cwd: string,
): Promise<VerifiedRead[] | null> {
  if (typeof item.command !== "string") return null;
  const plan = composedPlan(item.command);
  if (!plan) return terminalSkillReads(item, cwd, workspace, pluginRoots);
  const files = await composedFiles(plan.paths, cwd, workspace, pluginRoots);
  if (!files) return [];
  return composedReceipts(item.aggregated_output, files, plan);
}

async function terminalSkillReads(
  item: CodexItem,
  cwd: string,
  workspace: string,
  pluginRoots: string[],
): Promise<VerifiedRead[] | null> {
  const paths = terminalReadPaths(String(item.command));
  if (!paths) return null;
  const files = await composedFiles(paths, cwd, workspace, pluginRoots);
  if (!files) return [];
  return terminalReadReceipts(item.aggregated_output, files);
}

function terminalReadPaths(command: string): string[] | null {
  const commands = literalCommands(shellPayload(command).trim());
  if (!commands || commands.length < 2) return null;
  return terminalCommandPaths(commands);
}

function terminalCommandPaths(commands: string[]): string[] | null {
  const last = commands.slice(-1);
  const terminal = composedOperands(last);
  if (!terminal || terminal.length !== 1) return null;
  const prefix = terminalPrefixPaths(commands.slice(0, -1));
  return prefix ? [...prefix, ...terminal] : null;
}

function terminalPrefixPaths(commands: string[]): string[] | null {
  const paths: string[] = [];
  for (const command of commands) {
    if (readPrefix(command)) continue;
    const reads = composedOperands([command]);
    if (!reads) return null;
    paths.push(...reads);
  }
  return paths.length < MAX_NATIVE_READ_ATTEMPTS ? paths : null;
}

function terminalReadReceipts(
  output: unknown,
  files: Array<{ text: string; receipt: VerifiedRead | null }>,
): VerifiedRead[] {
  const last = files[files.length - 1];
  if (!last?.receipt) return [];
  return verifiedTerminalReceipts(output, files, last.text, last.receipt);
}

function verifiedTerminalReceipts(
  output: unknown,
  files: Array<{ text: string; receipt: VerifiedRead | null }>,
  text: string,
  receipt: VerifiedRead,
): VerifiedRead[] {
  if (typeof output !== "string") return [];
  if (ambiguousTerminalPrefix(files, text)) return [];
  const start = output.length - text.length;
  if (!composedOutputAt(output, text, start)) return [];
  return matchesComposedOutside(output, start, output.length, "none")
    ? [receipt]
    : [];
}

function ambiguousTerminalPrefix(
  files: Array<{ text: string; receipt: VerifiedRead | null }>,
  text: string,
): boolean {
  return files
    .slice(0, -1)
    .some((file) => file.receipt !== null || file.text.includes(text));
}

async function composedFiles(
  paths: string[],
  cwd: string,
  workspace: string,
  pluginRoots: string[],
) {
  const files = [];
  for (const path of paths) {
    const file = await composedFile(path, cwd, workspace, pluginRoots);
    if (!file) return null;
    files.push(file);
  }
  return files;
}

function composedReceipts(
  output: unknown,
  files: Array<{ text: string; receipt: VerifiedRead | null }>,
  plan: ComposedPlan,
) {
  let lastSkill = -1;
  files.forEach((file, index) => {
    if (file.receipt) lastSkill = index;
  });
  if (lastSkill < 0) return [];
  if (hasOrdinarySkillCopies(files))
    return copiedComposedReceipts(output, files, plan);
  // Later ordinary files may have changed since the command ran. Only bytes
  // needed to locate a Skill read participate in its content proof.
  if (
    !matchesComposedOutput(
      output,
      files
        .slice(0, lastSkill + 1)
        .map((file) => file.text)
        .join(""),
      plan,
      lastSkill < files.length - 1,
    )
  )
    return unmatchedComposedReceipts(output, files, plan);
  return composedFileReceipts(files);
}

function hasOrdinarySkillCopies(
  files: Array<{ text: string; receipt: VerifiedRead | null }>,
): boolean {
  const skills = files.filter((file) => file.receipt !== null);
  return files.some(
    (file) =>
      file.receipt === null &&
      skills.some((skill) => file.text.includes(skill.text)),
  );
}

function copiedComposedReceipts(
  output: unknown,
  files: Array<{ text: string; receipt: VerifiedRead | null }>,
  plan: ComposedPlan,
): VerifiedRead[] {
  const expected = files.map((file) => file.text).join("");
  return matchesComposedOutput(output, expected, plan, false)
    ? composedFileReceipts(files)
    : [];
}

function composedFileReceipts(
  files: Array<{ text: string; receipt: VerifiedRead | null }>,
): VerifiedRead[] {
  return files.flatMap((file) => (file.receipt ? [file.receipt] : []));
}

function unmatchedComposedReceipts(
  output: unknown,
  files: Array<{ text: string; receipt: VerifiedRead | null }>,
  plan: ComposedPlan,
): VerifiedRead[] {
  if (plan.singleCat) return singleCatReceipts(output, files);
  return plan.suffix === "none" ? terminalReadReceipts(output, files) : [];
}

function singleCatReceipts(
  output: unknown,
  files: Array<{ text: string; receipt: VerifiedRead | null }>,
): VerifiedRead[] {
  // A successful literal cat reads every operand. Verify ordered Skill spans
  // without matching current ordinary-file bytes, which may have changed.
  if (typeof output !== "string") return [];
  if (!files.some((file) => file.receipt === null)) return [];
  const reads = files.filter(
    (file): file is { text: string; receipt: VerifiedRead } =>
      file.receipt !== null,
  );
  const spans = orderedSkillSpans(output, reads);
  if (!spans) return [];
  return attributedFrontmatter(output, spans)
    ? reads.map((file) => file.receipt)
    : [];
}

function orderedSkillSpans(
  output: string,
  reads: Array<{ text: string }>,
): Array<{ start: number; end: number }> | null {
  const spans = [];
  let end = 0;
  for (const read of reads) {
    const start = output.indexOf(read.text, end);
    if (!composedOutputAt(output, read.text, start)) return null;
    end = start + read.text.length;
    spans.push({ start, end });
  }
  return spans;
}

function attributedFrontmatter(
  output: string,
  spans: Array<{ start: number; end: number }>,
): boolean {
  for (const match of output.matchAll(/^name: [A-Za-z0-9._-]+\r?$/gm)) {
    if (
      !spans.some((span) => match.index >= span.start && match.index < span.end)
    )
      return false;
  }
  return true;
}

function matchesComposedOutput(
  output: unknown,
  expected: string,
  plan: ComposedPlan,
  trailingFiles: boolean,
): boolean {
  if (typeof output !== "string" || expected.length === 0) return false;
  const start = plan.prefixed ? output.indexOf(expected) : 0;
  if (!composedOutputAt(output, expected, start)) return false;
  const end = start + expected.length;
  const suffix = composedSuffix(plan, trailingFiles);
  return matchesComposedOutside(output, start, end, suffix);
}

function composedSuffix(
  plan: ComposedPlan,
  trailingFiles: boolean,
): ComposedPlan["suffix"] | "files" {
  return trailingFiles ? "files" : plan.suffix;
}

function composedOutputAt(
  output: string,
  expected: string,
  start: number,
): boolean {
  return (
    start >= 0 &&
    output.startsWith(expected, start) &&
    output.indexOf(expected, start + 1) < 0
  );
}

function matchesComposedOutside(
  output: string,
  start: number,
  end: number,
  suffix: ComposedPlan["suffix"] | "files",
): boolean {
  if (suffix === "none" && end !== output.length) return false;
  const outside =
    output.slice(0, start) +
    (["discovery", "files"].includes(suffix) ? output.slice(end) : "");
  return noSkillFrontmatter(outside);
}

function noSkillFrontmatter(output: string): boolean {
  return !/(?:^|\n)name: [A-Za-z0-9._-]+\r?$/m.test(output);
}

async function composedFile(
  path: string,
  cwd: string,
  workspace: string,
  pluginRoots: string[],
) {
  const actual = await realpath(resolve(cwd, path)).catch(() => null);
  if (
    !actual ||
    ![workspace, ...pluginRoots].some((root) => containedFile(root, actual))
  )
    return null;
  const text = await composedFileText(actual);
  if (text === null) return null;
  const skill = mountedSkillName(actual, workspace, pluginRoots);
  return composedFileReceipt(path, actual, text, skill);
}

async function composedFileText(actual: string): Promise<string | null> {
  const metadata = await stat(actual).catch(() => null);
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.size > MAX_SKILL_BYTES) return null;
  const bytes = await readFile(actual).catch(() => null);
  return boundedFileText(bytes);
}

function boundedFileText(bytes: Buffer | null): string | null {
  return bytes && bytes.byteLength <= MAX_SKILL_BYTES
    ? bytes.toString("utf8")
    : null;
}

function containedFile(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child !== "" &&
    !child.startsWith(`..${sep}`) &&
    child !== ".." &&
    !isAbsolute(child)
  );
}

function composedFileReceipt(
  path: string,
  actual: string,
  text: string,
  skill: string | null,
) {
  if (skill === null) return { text, receipt: null };
  if (
    !/(?:^|\/)SKILL\.md$/.test(path) ||
    !text.startsWith("---\n") ||
    !text.includes(`\nname: ${skill}\n`)
  )
    return null;
  const receipt: VerifiedRead = {
    skill,
    path: actual,
    range: [0, text.length],
    bodyLength: text.length,
  };
  return { text, receipt };
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
  const composed = composedPlan(command);
  if (composed) return composed.paths;
  const shell = shellPayload(command).trim();
  const payload = compoundReadPayload(shell);
  const path = "(?:\"([^\"]+)\"|'([^']+)'|([^\\s'\"`$;&|<>]+))";
  const fallback = fallbackRead(payload, path);
  if (fallback) return [fallback.path, ...(fallback.fallbackPaths ?? [])];
  return [
    ...literalReadAttemptPaths(payload, path),
    ...sequentialReadAttemptPaths(shell, path),
    ...composedAttemptPaths(shell, path),
  ];
}

function composedAttemptPaths(shell: string, path: string): string[] {
  const commands = literalCommands(normalizedReadPayload(shell).payload) ?? [];
  return commands.flatMap((command) => literalReadAttemptPaths(command, path));
}

function sequentialReadAttemptPaths(payload: string, path: string): string[] {
  const first = payload.match(
    new RegExp(`^(${SEQUENTIAL_WORDS})[ \\t]*[;\\n]`),
  );
  if (!first) return [];
  // The suffix may be unsupported. This records an attempt, never read credit.
  return literalReadAttemptPaths(first.slice(1, 2).join(""), path);
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
    const value = capturedReadPath(sed, 1);
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
  if (!matchesReadOutput(declaration, text.slice(...range))) return null;
  return { skill, path: actual, range, bodyLength: text.length };
}

function matchesReadOutput(
  declaration: { read: DirectRead; output: string },
  expected: string,
): boolean {
  return declaration.output.startsWith(expected);
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
  if (typeof cwd !== "string") return null;
  const path = normalizedCommandCwd(cwd);
  return path ? realpath(path).catch(() => null) : null;
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
  if (read.length === 0) {
    state.partial = true;
    return;
  }
  for (const receipt of read) retainNativeRead(state, receipt, ordinal);
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
type RecoveredRead = RecoveredSkillRead;
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
  if (recovered.completeOutput) {
    return completeRecoveredItem(item, recovered);
  }
  return { ...item, aggregated_output: recovered.output + nativeOutput(item) };
}

function completeRecoveredItem(
  item: CodexItem,
  recovered: RecoveredRead,
): CodexItem {
  const native = nativeOutput(item);
  return native === "" || native === recovered.output
    ? { ...item, aggregated_output: recovered.output, cwd: recovered.cwd }
    : item;
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
  const cwd = await nativeReadCwd(item.cwd, context.workspace);
  if (!cwd) {
    state.partial = true;
    return false;
  }
  const attempted = await mountedSkillReadAttempt(
    item.command,
    context.workspace,
    context.pluginRoots,
    cwd,
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
  const read = await resolvedStreamSkillRead(item, context);
  if (read.length === 0) {
    state.partial = true;
    return;
  }
  for (const receipt of read) {
    const coverage = state.attempted.get(receipt.path) ?? {
      ranges: [],
      bodyLength: receipt.bodyLength,
    };
    retainStreamRead(state, receipt, coverage);
  }
}

async function resolvedStreamSkillRead(
  item: CodexItem,
  context: Pick<ReadContext, "workspace" | "pluginRoots">,
): Promise<VerifiedRead[]> {
  const cwd = await nativeReadCwd(item.cwd, context.workspace);
  return cwd
    ? verifiedSkillRead(item, context.workspace, context.pluginRoots, cwd)
    : [];
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
