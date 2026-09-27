import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

/** Hash visible worktree contents without retaining paths or file data. */
export async function workspaceFingerprint(
  root: string,
): Promise<string | null> {
  const identity = createHash("sha256");
  let entries = 0;
  let fileBytes = 0;
  async function visit(path: string): Promise<void> {
    entries++;
    if (entries > MAX_ENTRIES) throw new Error("workspace entry limit");
    const name = relative(root, path).split(sep).join("/");
    const info = await lstat(path);
    if (info.isDirectory()) {
      identity.update(`dir\0${name}\0`);
      for (const child of (await readdir(path)).sort()) {
        await visit(join(path, child));
      }
      return;
    }
    if (info.isSymbolicLink()) {
      identity.update(`link\0${name}\0${await readlink(path)}\0`);
      return;
    }
    if (!info.isFile() || !Number.isSafeInteger(info.size))
      throw new Error("unsupported workspace entry");
    if (fileBytes + info.size > MAX_FILE_BYTES)
      throw new Error("workspace byte limit");
    const content = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
      fileBytes += chunk.byteLength;
      if (fileBytes > MAX_FILE_BYTES) throw new Error("workspace byte limit");
      content.update(chunk);
    }
    identity.update(
      `file\0${name}\0${info.mode & 0o111 ? "x" : "-"}\0${content.digest("hex")}\0`,
    );
  }
  try {
    for (const entry of (await readdir(root)).sort()) {
      if (entry === ".git") continue;
      await visit(join(root, entry));
    }
    return identity.digest("hex");
  } catch {
    return null;
  }
}
