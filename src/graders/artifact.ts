import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
const MAX_ARTIFACT_BYTES = 64 * 1024;

export function validateArtifactPath(path: unknown): asserts path is string {
  if (
    typeof path !== "string" ||
    !path.trim() ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === ".." || part === ".git") ||
    dirname(path).includes("*") ||
    !/^[^*]*\*?[^*]*$/.test(basename(path))
  )
    throw new Error(
      "semantic artifact path must be relative with at most one basename *",
    );
}
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

export async function readSemanticArtifact(
  repoDir: string,
  pattern: string,
): Promise<{ path: string; content: string }> {
  validateArtifactPath(pattern);
  const root = await realpath(repoDir);
  const dir = resolve(root, dirname(pattern));
  if (!within(root, dir))
    throw new Error("semantic artifact directory escapes the fixture");
  const directory = await realpath(dir);
  if (!within(root, directory))
    throw new Error("semantic artifact directory escapes the fixture");
  if (relative(root, directory).split(sep).includes(".git"))
    throw new Error("semantic artifact directory resolves to Git metadata");
  const name = basename(pattern);
  const matches = name.includes("*")
    ? (await readdir(directory)).filter((entry) => {
        const [prefix, suffix] = name.split("*");
        return entry.startsWith(prefix!) && entry.endsWith(suffix!);
      })
    : [name];
  if (matches.length !== 1)
    throw new Error(
      `semantic artifact pattern matched ${matches.length} files`,
    );
  const path = join(directory, matches[0]!);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES)
    throw new Error(
      "semantic artifact must be a regular file of at most 64 KiB",
    );
  const resolved = await realpath(path);
  if (!within(root, resolved))
    throw new Error("semantic artifact escapes the fixture");
  if (relative(root, resolved).split(sep).includes(".git"))
    throw new Error("semantic artifact resolves to Git metadata");
  return {
    path: relative(root, resolved),
    content: await readFile(resolved, "utf8"),
  };
}
