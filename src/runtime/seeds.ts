import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { hashJson, sha256 } from "../identity";
import type { RuntimePolicy } from "./config";
import { insideRuntimeRoot } from "./paths";

class SeedSnapshot {
  private entries = 0;
  private bytes = 0;
  private readonly files: {
    path: string;
    sha256: string;
    mode: number;
    bytes: Buffer | null;
  }[] = [];
  constructor(
    private readonly root: string,
    private readonly retainContents = false,
  ) {}

  async digest(): Promise<string> {
    await this.visit("", new Set());
    return hashJson(
      this.files.map(({ path, sha256, mode }) => ({ path, sha256, mode })),
    );
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
      this.files.push({
        path,
        sha256: "directory",
        mode: info.mode & 0o777,
        bytes: null,
      });
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
    const bytes = await readFile(canonical);
    this.files.push({
      path,
      sha256: sha256(bytes),
      mode: info.mode & 0o777,
      bytes: this.retainContents ? bytes : null,
    });
  }
  async materialize(target: string): Promise<void> {
    for (const file of this.files) {
      const path = join(target, file.path);
      if (file.bytes === null) await mkdir(path, { mode: 0o700 });
      else
        await writeFile(path, file.bytes, {
          flag: "wx",
          mode: file.mode,
        });
    }
    for (const file of [...this.files].reverse())
      await chmod(join(target, file.path), file.mode);
  }
}

export async function runtimeSeedDigest(source: string): Promise<string> {
  return new SeedSnapshot(await realpath(source)).digest();
}

type RuntimeSeed = NonNullable<RuntimePolicy["seeds"]>[number];
const verifiedSeeds = new WeakMap<
  RuntimeSeed,
  { source: string; digest: string; snapshot: Promise<SeedSnapshot> }
>();

/** Contents stay in runner memory; no writable role or filesystem alias owns them. */
export async function materializeRuntimeSeed(
  seed: RuntimeSeed,
  target: string,
): Promise<void> {
  let verified = verifiedSeeds.get(seed);
  if (verified?.source !== seed.source || verified.digest !== seed.sha256) {
    verified = {
      source: seed.source,
      digest: seed.sha256,
      snapshot: verifiedSnapshot(seed),
    };
    verifiedSeeds.set(seed, verified);
  }
  await (await verified.snapshot).materialize(target);
}

async function verifiedSnapshot(seed: RuntimeSeed): Promise<SeedSnapshot> {
  const snapshot = new SeedSnapshot(await realpath(seed.source), true);
  if ((await snapshot.digest()) !== seed.sha256)
    throw new Error("runtime seed changed after configuration snapshot");
  return snapshot;
}
