import { parse as parseShell } from "shell-quote";
type ShellTokens = ReturnType<typeof parseShell>;

export function programName(program: string | undefined): string {
  return program?.split("/").at(-1) ?? "";
}

function nestedShell(
  words: string[],
  requireFlag: boolean,
): string | undefined {
  if (!shellWords(words)) return undefined;
  if (requireFlag && !shellFlag(words[1])) return undefined;
  return words[2];
}
function shellWords(words: string[]): boolean {
  return (
    words.length === 3 && ["sh", "bash", "zsh"].includes(programName(words[0]))
  );
}
function shellFlag(flag: string | undefined): boolean {
  return ["-c", "-lc"].includes(flag ?? "");
}

function segments(tokens: ShellTokens): string[][] | null {
  const result: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    const word = literalWord(token);
    if (word !== undefined) current.push(word);
    else if (separator(token)) {
      result.push(current);
      current = [];
    } else return null;
  }
  result.push(current);
  return result;
}

function separator(token: ShellTokens[number]): boolean {
  return (
    typeof token !== "string" &&
    "op" in token &&
    ["&&", ";", "|"].includes(token.op)
  );
}

function literalWord(token: ShellTokens[number]): string | undefined {
  if (typeof token === "string") return token;
  if (!("op" in token) || token.op !== "glob") return undefined;
  return /^[A-Za-z0-9_./]/.test(token.pattern) ? token.pattern : undefined;
}

function readonlySed(args: string[]): boolean {
  return (
    args[0] === "-n" && /^\d+(?:,\d+)?p(?:;\d+(?:,\d+)?p)*$/.test(args[1] ?? "")
  );
}

function readonlySegment([program, ...args]: string[]): boolean {
  const name = programName(program);
  if (
    ["pwd", "cat", "ls", "head", "tail", "nl", "wc", "echo", "printf"].includes(
      name,
    )
  )
    return true;
  switch (name) {
    case "rg":
    case "grep":
      return !args.some((arg) =>
        /^(?:--pre|--hostname-bin|--hyperlink-format)(?:=|$)/.test(arg),
      );
    case "sed":
      return readonlySed(args);
    default:
      return false;
  }
}

function readonlyTokens(tokens: ShellTokens, depth: number): boolean {
  const nested = nestedShell(
    tokens.filter((token): token is string => typeof token === "string"),
    true,
  );
  if (nested !== undefined) return readOnlyCommand(nested, depth + 1);
  const parts = segments(tokens);
  if (!parts) return false;
  return (
    parts.some((part) => part.length) &&
    parts.filter((part) => part.length).every(readonlySegment)
  );
}

export function readOnlyCommand(command: string, depth = 0): boolean {
  if (depth > 2 || /\$\(|`/.test(command)) return false;
  try {
    return readonlyTokens(parseShell(command), depth);
  } catch {
    return false;
  }
}

function listingArgument(argument: string): boolean {
  return (
    /^-[A-Za-z]*[clL][A-Za-z]*$/.test(argument) ||
    /^(?:--files|--files-with-matches|--files-without-match|--count|--count-matches)(?:=|$)/.test(
      argument,
    )
  );
}

function contentSegment([program, ...args]: string[]): boolean {
  const name = programName(program);
  if (["cat", "head", "tail", "nl", "sed"].includes(name)) return true;
  return ["rg", "grep"].includes(name) && !args.some(listingArgument);
}

export function contentCommands(command: string, depth = 0): string[][] {
  if (!contentAllowed(command, depth)) return [];
  const tokens = parseShell(command),
    nested = nestedShell(
      tokens.filter((token): token is string => typeof token === "string"),
      false,
    );
  if (nested !== undefined) return contentCommands(nested, depth + 1);
  return (segments(tokens) ?? []).filter(contentSegment);
}
function contentAllowed(command: string, depth: number): boolean {
  return depth <= 2 && readOnlyCommand(command);
}
