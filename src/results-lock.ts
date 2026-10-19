import { Database } from "bun:sqlite";
import { join } from "node:path";
import { lstat } from "node:fs/promises";

export async function retainedFile(path: string) {
  const info = await lstat(path).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
  if (info && !info.isFile())
    throw new Error(`retained storage must be a regular file: ${path}`);
  return info;
}

/** Serialize result publication and pruning across CLI processes. Closing rolls back the lock transaction. */
export async function withResultsLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  await retainedFile(join(root, ".retention-lock.sqlite"));
  const database = new Database(join(root, ".retention-lock.sqlite"));
  try {
    database.run("PRAGMA busy_timeout = 5000");
    database.run("BEGIN IMMEDIATE");
    return await action();
  } finally {
    database.close();
  }
}
