import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

async function containingRepository(root: string): Promise<string | null> {
  let directory = (await stat(root)).isDirectory() ? root : dirname(root);
  while (true) {
    try {
      await lstat(join(directory, ".git"));
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("protected repository metadata is unreadable");
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Protect the primary checkout and linked worktrees without requiring Git. */
export async function protectedWorktrees(root: string): Promise<string[]> {
  const repository = await containingRepository(root);
  if (!repository) return [];
  const result = Bun.spawnSync(
    ["git", "-C", repository, "worktree", "list", "--porcelain", "-z"],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  if (result.exitCode !== 0 || result.stdout.byteLength > 1024 * 1024)
    throw new Error("protected repository worktrees are unavailable");
  const paths = result.stdout
    .toString()
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice(9));
  if (!paths.length || paths.some((path) => !isAbsolute(path)))
    throw new Error("protected repository worktree paths are invalid");
  const existing: string[] = [];
  for (const path of paths) {
    try {
      existing.push(await realpath(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("protected repository worktree is unreadable");
    }
  }
  return existing;
}
