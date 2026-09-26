import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import packageJson from "../package.json";
import { hashJson } from "./identity";

const MAX_DIRTY_BYTES = 32 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root: string, ...arguments_: string[]): Buffer {
  const result = Bun.spawnSync(["git", "-C", root, ...arguments_], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0)
    throw new Error("local Sevro checkout Git identity is unavailable");
  if (result.stdout.byteLength > MAX_DIRTY_BYTES)
    throw new Error("local Sevro checkout identity exceeds the size limit");
  return Buffer.from(result.stdout);
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
  const trackedPatch = git(canonicalRoot, "diff", "--binary", "HEAD", "--");
  const untrackedPaths = git(
    canonicalRoot,
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
    const absolute = resolve(canonicalRoot, path);
    const relativePath = relative(canonicalRoot, absolute);
    if (
      isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`)
    )
      throw new Error("local Sevro checkout has an unsafe untracked path");
    const info = await lstat(absolute);
    const bytes = info.isSymbolicLink()
      ? Buffer.from(await readlink(absolute), "utf8")
      : info.isFile()
        ? await readFile(absolute)
        : null;
    if (!bytes)
      throw new Error(
        "local Sevro checkout has an unsupported untracked entry",
      );
    dirtyBytes += bytes.byteLength;
    if (dirtyBytes > MAX_DIRTY_BYTES)
      throw new Error("local Sevro checkout identity exceeds the size limit");
    untracked.push({ path, sha256: sha256(bytes) });
  }
  return {
    source: "checkout" as const,
    root: pathToFileURL(canonicalRoot).href,
    revision,
    dirtyPatchDigest:
      trackedPatch.byteLength || untracked.length
        ? hashJson({ trackedPatch: sha256(trackedPatch), untracked })
        : null,
    buildDigest,
  };
}

export async function runnerProvenance(buildDigest: string) {
  if (!packageJson.private)
    return {
      source: "package" as const,
      packageName: packageJson.name,
      version: packageJson.version,
      buildDigest,
    };
  return checkoutProvenance(join(import.meta.dir, ".."), buildDigest);
}
