import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_TOOLS = 64;
const MAX_BYTES = 1024 * 1024;

/** Validate executable fixture tools without allowing path traversal. */
export function prepareFixtureBin(
  value: unknown,
): Record<string, string> | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid fixture binaries");
  const bin = value as Record<string, unknown>;
  const entries = Object.entries(bin);
  if (
    entries.length > MAX_TOOLS ||
    entries.some(
      ([name, content]) =>
        !/^[A-Za-z][A-Za-z0-9._-]*$/.test(name) ||
        name.length > 64 ||
        typeof content !== "string" ||
        !content ||
        content.includes("\0"),
    ) ||
    entries.reduce(
      (size, [name, content]) =>
        size +
        Buffer.byteLength(name, "utf8") +
        Buffer.byteLength(content as string, "utf8"),
      0,
    ) > MAX_BYTES
  )
    throw new Error("invalid fixture binaries");
  return bin as Record<string, string>;
}

/** Install declared tools inside the fixture's Git metadata, after commits. */
export async function installFixtureBin(
  bin: Record<string, string> | undefined,
  workspace: string,
): Promise<void> {
  if (!bin || Object.keys(bin).length === 0) return;
  const directory = join(workspace, ".git", "fixture-bin");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("fixture binary directory is invalid");
  for (const [name, content] of Object.entries(bin)) {
    const target = join(directory, name);
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink())
        throw new Error("fixture binary target is invalid");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    await writeFile(target, content, { mode: 0o755 });
    await chmod(target, 0o755);
  }
}

/** Setup may also install trusted tools, such as a repository ticket stub. */
export async function fixtureBinDirectory(
  workspace: string,
): Promise<string | null> {
  const path = join(workspace, ".git", "fixture-bin");
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("fixture binary directory is invalid");
    const canonicalWorkspace = await realpath(workspace);
    const canonicalBin = await realpath(path);
    if (canonicalBin !== join(canonicalWorkspace, ".git", "fixture-bin"))
      throw new Error("fixture binary directory escapes the workspace");
    return path;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
