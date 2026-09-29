import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

function permissionFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

async function restoreDirectoryAccess(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory()) return;
  await chmod(path, (entry.mode & 0o7777) | 0o700);
  for (const child of await readdir(path, { withFileTypes: true }))
    if (child.isDirectory())
      await restoreDirectoryAccess(join(path, child.name));
}

/** Clear a completed fixture while preserving its reserved root for active peers. */
export async function clearFixtureContents(workspace: string): Promise<void> {
  const root = await lstat(workspace);
  if (!root.isDirectory())
    throw new Error("fixture workspace is not a directory");
  if ((root.mode & 0o700) !== 0o700)
    await chmod(workspace, (root.mode & 0o7777) | 0o700);
  const names = await readdir(workspace);
  await Promise.all(
    names.map(async (name) => {
      const path = join(workspace, name);
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        if (!permissionFailure(error)) throw error;
        await restoreDirectoryAccess(path);
        await rm(path, { recursive: true, force: true });
      }
    }),
  );
}
