import { isMissingFile } from "../fixture-tools";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

async function containingRepository(root: string): Promise<string | null> {
  let directory = (await stat(root)).isDirectory() ? root : dirname(root);
  for (;;) {
    if (await hasRepositoryMetadata(directory)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function hasRepositoryMetadata(directory: string): Promise<boolean> {
  try {
    await lstat(join(directory, ".git"));
    return true;
  } catch (cause) {
    if (isMissingFile(cause)) return false;
    throw new Error("protected repository metadata is unreadable", { cause });
  }
}

/** Protect the primary checkout and linked worktrees without requiring Git. */
export async function protectedWorktrees(root: string): Promise<string[]> {
  const repository = await containingRepository(root);
  if (!repository) return [];
  const paths = listWorktreePaths(repository);
  const existing: string[] = [];
  for (const path of paths) {
    try {
      existing.push(await realpath(path));
    } catch (error) {
      if (!isMissingFile(error))
        throw new Error("protected repository worktree is unreadable", {
          cause: error,
        });
    }
  }
  return existing;
}

function listWorktreePaths(repository: string): string[] {
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
  validateWorktreePaths(paths);
  return paths;
}

function validateWorktreePaths(paths: string[]): void {
  if (!paths.length || paths.some((path) => !isAbsolute(path)))
    throw new Error("protected repository worktree paths are invalid");
}
