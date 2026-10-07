import { chmod, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./value-guards";

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validContent(content: unknown): content is string {
  return (
    typeof content === "string" && content.length > 0 && !content.includes("\0")
  );
}

function validEntry(
  [name, content]: [string, unknown],
  pattern: RegExp,
): boolean {
  return pattern.test(name) && name.length <= 64 && validContent(content);
}

function declarationBytes(entries: [string, unknown][]): number {
  return entries.reduce(
    (size, [name, content]) =>
      size +
      Buffer.byteLength(name, "utf8") +
      Buffer.byteLength(content as string, "utf8"),
    0,
  );
}

/** Shared bounds for trusted Git hook and fixture executable declarations. */
export function prepareFixtureTools(
  value: unknown,
  pattern: RegExp,
  maxTools: number,
  message: string,
): Record<string, string> | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error(message);
  const entries = Object.entries(value);
  validateToolBounds(entries, pattern, maxTools, message);
  return value as Record<string, string>;
}

function validateToolBounds(
  entries: [string, unknown][],
  pattern: RegExp,
  maxTools: number,
  message: string,
): void {
  if (
    entries.length > maxTools ||
    entries.some((entry) => !validEntry(entry, pattern)) ||
    declarationBytes(entries) > 1024 * 1024
  )
    throw new Error(message);
}

async function validateToolTarget(
  path: string,
  message: string,
): Promise<void> {
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error(message);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

/** Preserve target-type checks and executable modes for both declaration kinds. */
export async function installFixtureTools(
  tools: Record<string, string>,
  directory: string,
  messages: { directory: string; target: string },
): Promise<void> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error(messages.directory);
  for (const [name, content] of Object.entries(tools)) {
    const target = join(directory, name);
    await validateToolTarget(target, messages.target);
    await writeFile(target, content, { mode: 0o755 });
    await chmod(target, 0o755);
  }
}
