import { chmod, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_HOOKS = 32;
const MAX_HOOK_BYTES = 1024 * 1024;

/** Bound hook declarations and keep every name inside Git's hooks directory. */
export function prepareGitHooks(value: unknown): Record<string, string> | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid fixture hooks");
  const hooks = value as Record<string, unknown>;
  const entries = Object.entries(hooks);
  if (
    entries.length > MAX_HOOKS ||
    entries.some(
      ([name, content]) =>
        !/^[a-z][a-z0-9-]*$/.test(name) ||
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
    ) > MAX_HOOK_BYTES
  )
    throw new Error("invalid fixture hooks");
  return hooks as Record<string, string>;
}

/** Install executable hooks only after fixture commits and overlays are ready. */
export async function installGitHooks(
  hooks: Record<string, string> | undefined,
  workspace: string,
): Promise<void> {
  if (!hooks) return;
  const directory = join(workspace, ".git", "hooks");
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("fixture Git hooks directory is invalid");
  for (const [name, content] of Object.entries(hooks)) {
    const target = join(directory, name);
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink())
        throw new Error("fixture Git hook target is invalid");
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
