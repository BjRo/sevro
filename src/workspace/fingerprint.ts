import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

class WorkspaceFingerprint {
  private readonly identity = createHash("sha256");
  private entries = 0;
  private fileBytes = 0;
  constructor(private readonly root: string) {}

  async digest(): Promise<string> {
    for (const entry of (await readdir(this.root)).sort()) {
      if (entry === ".git") continue;
      await this.visit(join(this.root, entry));
    }
    return this.identity.digest("hex");
  }

  private async visit(path: string): Promise<void> {
    this.entries++;
    if (this.entries > MAX_ENTRIES) throw new Error("workspace entry limit");
    const name = relative(this.root, path).split(sep).join("/");
    const info = await lstat(path);
    if (info.isDirectory()) await this.directory(path, name);
    else if (info.isSymbolicLink())
      this.identity.update(`link\0${name}\0${await readlink(path)}\0`);
    else await this.file(path, name, info);
  }

  private async directory(path: string, name: string): Promise<void> {
    this.identity.update(`dir\0${name}\0`);
    for (const child of (await readdir(path)).sort())
      await this.visit(join(path, child));
  }

  private async file(path: string, name: string, info: Stats): Promise<void> {
    if (!info.isFile() || !Number.isSafeInteger(info.size))
      throw new Error("unsupported workspace entry");
    if (this.fileBytes + info.size > MAX_FILE_BYTES)
      throw new Error("workspace byte limit");
    const digest = await this.fileHash(path);
    this.identity.update(
      `file\0${name}\0${info.mode & 0o111 ? "x" : "-"}\0${digest}\0`,
    );
  }

  private async fileHash(path: string): Promise<string> {
    const content = createHash("sha256");
    for await (const value of createReadStream(path)) {
      const chunk: unknown = value;
      if (!Buffer.isBuffer(chunk))
        throw new Error("unsupported workspace entry");
      this.fileBytes += chunk.byteLength;
      if (this.fileBytes > MAX_FILE_BYTES)
        throw new Error("workspace byte limit");
      content.update(chunk);
    }
    return content.digest("hex");
  }
}

/** Hash visible worktree contents without retaining paths or file data. */
export async function workspaceFingerprint(
  root: string,
): Promise<string | null> {
  try {
    return await new WorkspaceFingerprint(root).digest();
  } catch {
    return null;
  }
}
