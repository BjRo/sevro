import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import packageJson from "../package.json";
import { hashJson } from "./identity";

const MAX_DIRTY_BYTES = 32 * 1024 * 1024;
const MAX_BUILD_BYTES = 64 * 1024 * 1024;
const MAX_BUILD_FILES = 4096;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type BuildFile = { path: string; sha256: string };
type ProjectFile = BuildFile & { executable: boolean };
function fileOrder(left: BuildFile, right: BuildFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

class BuildSnapshot {
  readonly files: BuildFile[] = [];
  private bytes = 0;
  constructor(private root: string) {}
  async collect(path: string): Promise<void> {
    const absolute = join(this.root, path),
      info = await lstat(absolute);
    if (info.isSymbolicLink())
      throw new Error("package build contains a symbolic link");
    if (info.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort())
        await this.collect(join(path, entry));
      return;
    }
    await this.collectFile(path, absolute, info);
  }
  private async collectFile(
    path: string,
    absolute: string,
    info: Stats,
  ): Promise<void> {
    if (!info.isFile()) throw new Error("package build contains a non-file");
    const bytes = await readFile(absolute);
    this.bytes += bytes.byteLength;
    if (this.files.length >= MAX_BUILD_FILES || this.bytes > MAX_BUILD_BYTES)
      throw new Error("package build exceeds the size limit");
    this.files.push({ path: path.split(sep).join("/"), sha256: sha256(bytes) });
  }
}

/** Digest the packaged runtime and public contract files in path order. */
export async function packageBuildDigest(
  root = join(import.meta.dir, ".."),
): Promise<string> {
  const snapshot = new BuildSnapshot(await realpath(root));
  for (const path of [
    "package.json",
    "README.md",
    "docs",
    "examples",
    "schemas",
    "src",
  ])
    await snapshot.collect(path);
  return hashJson({
    format: "sevro.build.v1",
    files: snapshot.files.sort(fileOrder),
  });
}

class ProjectSnapshot {
  readonly files: ProjectFile[] = [];
  private bytes = 0;
  constructor(
    private root: string,
    private excluded: Set<string>,
  ) {}
  private isExcluded(path: string): boolean {
    return path === ".git" || this.excluded.has(path);
  }
  async collect(path: string): Promise<void> {
    if (this.isExcluded(path)) return;
    const absolute = join(this.root, path),
      info = await lstat(absolute);
    if (info.isSymbolicLink())
      throw new Error("project snapshot contains a symbolic link");
    if (info.isDirectory()) {
      await this.collectDirectory(path, absolute);
      return;
    }
    await this.collectFile(path, absolute, info);
  }
  private async collectDirectory(
    path: string,
    absolute: string,
  ): Promise<void> {
    for (const entry of (await readdir(absolute)).sort())
      await this.collect(path === "" ? entry : join(path, entry));
  }
  private async collectFile(
    path: string,
    absolute: string,
    info: Stats,
  ): Promise<void> {
    if (!info.isFile()) throw new Error("project snapshot contains a non-file");
    const bytes = await readFile(absolute);
    this.bytes += bytes.byteLength;
    if (this.files.length >= MAX_BUILD_FILES || this.bytes > MAX_BUILD_BYTES)
      throw new Error("project snapshot exceeds the size limit");
    this.files.push({
      path: path.split(sep).join("/"),
      sha256: sha256(bytes),
      executable: Boolean(info.mode & 0o111),
    });
  }
}
export async function projectIdentityDigest(
  root: string,
  provenance: { revision: string | null; dirtyPatchDigest: string | null },
  excludedRoots: string[] = [],
): Promise<string> {
  if (provenance.revision)
    return hashJson({
      format: "sevro.project.v1",
      revision: provenance.revision,
      dirtyPatchDigest: provenance.dirtyPatchDigest,
    });
  const projectRoot = resolve(root),
    excluded = new Set(
      excludedRoots.map((path) => relative(projectRoot, resolve(path))),
    );
  const snapshot = new ProjectSnapshot(projectRoot, excluded);
  await snapshot.collect("");
  return hashJson({
    format: "sevro.project.v1",
    files: snapshot.files.sort(fileOrder),
  });
}

function git(root: string, ...arguments_: string[]): Buffer {
  const result = Bun.spawnSync(["git", "-C", root, ...arguments_], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) throw new Error("Git identity is unavailable");
  if (result.stdout.byteLength > MAX_DIRTY_BYTES)
    throw new Error("Git identity exceeds the size limit");
  return Buffer.from(result.stdout);
}

async function dirtyPatchDigest(gitRoot: string): Promise<string | null> {
  const trackedPatch = git(gitRoot, "diff", "--binary", "HEAD", "--");
  const untrackedPaths = git(
    gitRoot,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  let dirtyBytes = trackedPatch.byteLength;
  const untracked: { path: string; sha256: string }[] = [];
  for (const path of untrackedPaths) {
    const bytes = await untrackedIdentityBytes(gitRoot, path);
    dirtyBytes += bytes.byteLength;
    if (dirtyBytes > MAX_DIRTY_BYTES)
      throw new Error("Git identity exceeds the size limit");
    untracked.push({ path, sha256: sha256(bytes) });
  }
  return trackedPatch.byteLength || untracked.length
    ? hashJson({ trackedPatch: sha256(trackedPatch), untracked })
    : null;
}

function requireSafeUntrackedPath(root: string, absolute: string): void {
  const path = relative(root, absolute);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
    throw new Error("Git checkout has an unsafe untracked path");
}
async function untrackedIdentityBytes(
  root: string,
  path: string,
): Promise<Buffer> {
  const absolute = resolve(root, path);
  requireSafeUntrackedPath(root, absolute);
  const info = await lstat(absolute);
  if (info.isSymbolicLink())
    return Buffer.from(await readlink(absolute), "utf8");
  if (info.isFile()) return readFile(absolute);
  throw new Error("Git checkout has an unsupported untracked entry");
}

/** Local development identity; packaged use never calls Git. */
export async function checkoutProvenance(root: string, buildDigest: string) {
  const canonicalRoot = await realpath(root);
  const gitRoot = await realpath(
    git(canonicalRoot, "rev-parse", "--show-toplevel").toString().trim(),
  );
  if (gitRoot !== canonicalRoot)
    throw new Error(
      "local Sevro checkout root does not match its Git repository",
    );
  const revision = git(canonicalRoot, "rev-parse", "HEAD").toString().trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error("local Sevro checkout revision is invalid");
  return {
    source: "checkout" as const,
    root: pathToFileURL(canonicalRoot).href,
    revision,
    dirtyPatchDigest: await dirtyPatchDigest(canonicalRoot),
    buildDigest,
  };
}

async function enclosingGitRoot(root: string): Promise<string | null> {
  let path = root;
  for (;;) {
    if (await gitMetadataAt(path)) return path;
    const parent = dirname(path);
    if (parent === path) return null;
    path = parent;
  }
}

async function gitMetadataAt(path: string): Promise<boolean> {
  try {
    const metadataPath = join(path, ".git");
    const metadata = await lstat(metadataPath);
    return !(await emptyTemporaryGitPlaceholder(path, metadataPath, metadata));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function emptyTemporaryGitPlaceholder(
  directory: string,
  metadataPath: string,
  metadata: Stats,
): Promise<boolean> {
  // Codex's Linux sandbox can leave an empty mount placeholder at /tmp/.git.
  return (
    directory === tmpdir() &&
    metadata.isDirectory() &&
    (await readdir(metadataPath)).length === 0
  );
}

export async function projectProvenance(root: string) {
  const canonicalRoot = await realpath(root);
  const gitEntryRoot = await enclosingGitRoot(canonicalRoot);
  if (!gitEntryRoot)
    return {
      root: pathToFileURL(canonicalRoot).href,
      revision: null,
      dirtyPatchDigest: null,
    };
  const gitRoot = await realpath(
    git(canonicalRoot, "rev-parse", "--show-toplevel").toString().trim(),
  );
  if (gitRoot !== gitEntryRoot)
    throw new Error("project Git root does not match its repository entry");
  let revision: string;
  try {
    revision = git(gitRoot, "rev-parse", "HEAD").toString().trim();
  } catch {
    git(gitRoot, "status", "--porcelain");
    return {
      root: pathToFileURL(canonicalRoot).href,
      revision: null,
      dirtyPatchDigest: null,
    };
  }
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error("project Git revision is invalid");
  return {
    root: pathToFileURL(canonicalRoot).href,
    revision,
    dirtyPatchDigest: await dirtyPatchDigest(gitRoot),
  };
}

export async function runnerProvenance(
  buildDigest: string,
  checkoutRoot?: string,
) {
  if (checkoutRoot) {
    const actualRoot = await realpath(join(import.meta.dir, ".."));
    if ((await realpath(checkoutRoot)) !== actualRoot)
      throw new Error(
        "local Sevro checkout root does not match the running package",
      );
    return checkoutProvenance(actualRoot, buildDigest);
  }
  return {
    source: "package" as const,
    packageName: packageJson.name,
    version: packageJson.version,
    buildDigest,
  };
}
