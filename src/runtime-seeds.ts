import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { hashJson, sha256 } from "./identity";
import { insideRuntimeRoot } from "./runtime-paths";

class SeedSnapshot {
  private entries = 0;
  private bytes = 0;
  private readonly files: { path: string; sha256: string; mode: number }[] = [];
  constructor(private readonly root: string) {}

  async digest(): Promise<string> {
    await this.visit("", new Set());
    return hashJson(this.files);
  }

  private async visit(path: string, ancestors: Set<string>): Promise<void> {
    const logical = join(this.root, path);
    const canonical = await realpath(logical);
    if (!insideRuntimeRoot(this.root, canonical))
      throw new Error("runtime seed link escapes its source");
    if (++this.entries > 16384)
      throw new Error("runtime seed exceeds entry limit");
    const info = await stat(canonical);
    if (info.isDirectory()) {
      this.files.push({ path, sha256: "directory", mode: info.mode & 0o777 });
      await this.visitDirectory(path, canonical, ancestors);
      return;
    }
    if (!info.isFile())
      throw new Error("runtime seed contains an unsupported file");
    await this.visitFile(path, canonical, info);
  }

  private async visitDirectory(
    path: string,
    canonical: string,
    ancestors: Set<string>,
  ): Promise<void> {
    if (ancestors.has(canonical))
      throw new Error("runtime seed contains a directory cycle");
    const parents = new Set([...ancestors, canonical]);
    for (const name of (await readdir(canonical)).sort())
      await this.visit(join(path, name), parents);
  }

  private async visitFile(
    path: string,
    canonical: string,
    info: { size: number; mode: number },
  ): Promise<void> {
    this.bytes += info.size;
    if (this.bytes > 512 * 1024 * 1024)
      throw new Error("runtime seed exceeds 512 MiB");
    this.files.push({
      path,
      sha256: sha256(await readFile(canonical)),
      mode: info.mode & 0o777,
    });
  }
}

export async function runtimeSeedDigest(source: string): Promise<string> {
  return new SeedSnapshot(await realpath(source)).digest();
}
