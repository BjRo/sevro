import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Copy a directory tree into a destination the caller has already reserved.
 * The destination must exist and be empty; the copy never overwrites an entry.
 * The reserved directory itself stays in place, so the caller keeps its mode,
 * grants and exclusive claim on the path. Each top-level entry is copied to a
 * path that cannot exist yet, which keeps the result independent of how a
 * Node release treats an existing destination directory: Node 24.14 began
 * refusing it under `errorOnExist`, while earlier releases and Bun merge.
 */
export async function copyIntoReservedDirectory(
  source: string,
  destination: string,
  options: { dereference?: boolean } = {},
): Promise<void> {
  if ((await readdir(destination)).length)
    throw new Error(`reserved directory is not empty: ${destination}`);
  for (const entry of await readdir(source))
    await cp(join(source, entry), join(destination, entry), {
      recursive: true,
      dereference: options.dereference ?? false,
      errorOnExist: true,
      force: false,
    });
}
