import { openLockDatabase } from "./sqlite-lock";
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
  const release = await acquireResultsLock(root);
  try {
    return await action();
  } finally {
    release();
  }
}

/** Hold a root lock while discovering and validating additional nested roots. */
export async function acquireResultsLock(root: string): Promise<() => void> {
  await retainedFile(join(root, ".retention-lock.sqlite"));
  const database = openLockDatabase(join(root, ".retention-lock.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
    return () => {
      database.close();
    };
  } catch (cause) {
    database.close();
    throw cause;
  }
}
