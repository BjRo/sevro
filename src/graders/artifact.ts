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
  if (typeof path !== "string" || !validArtifactPath(path))
    throw new Error(
      "semantic artifact path must be relative with at most one basename *",
    );
}

function validArtifactPath(path: string): boolean {
  return (
    safeRelativePath(path) &&
    !dirname(path).includes("*") &&
    /^[^*]*\*?[^*]*$/.test(basename(path))
  );
}

function safeRelativePath(path: string): boolean {
  return (
    Boolean(path.trim()) &&
    !path.includes("\\") &&
    !isAbsolute(path) &&
    !path.split("/").some((part) => part === ".." || part === ".git")
  );
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

async function artifactDirectory(
  root: string,
  pattern: string,
): Promise<string> {
  const dir = resolve(root, dirname(pattern));
  if (!within(root, dir))
    throw new Error("semantic artifact directory escapes the fixture");
  const directory = await realpath(dir);
  if (!within(root, directory))
    throw new Error("semantic artifact directory escapes the fixture");
  if (relative(root, directory).split(sep).includes(".git"))
    throw new Error("semantic artifact directory resolves to Git metadata");
  return directory;
}

async function artifactMatches(
  directory: string,
  name: string,
): Promise<string[]> {
  if (!name.includes("*")) return [name];
  const [prefix = "", suffix = ""] = name.split("*");
  return (await readdir(directory)).filter(
    (entry) => entry.startsWith(prefix) && entry.endsWith(suffix),
  );
}

function selectedArtifact(directory: string, matches: string[]): string {
  const [name] = matches;
  if (matches.length !== 1 || name === undefined)
    throw new Error(
      `semantic artifact pattern matched ${matches.length} files`,
    );
  return join(directory, name);
}

async function resolveArtifact(root: string, path: string): Promise<string> {
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
  return resolved;
}

export async function readSemanticArtifact(
  repoDir: string,
  pattern: string,
): Promise<{ path: string; content: string }> {
  validateArtifactPath(pattern);
  const root = await realpath(repoDir);
  const directory = await artifactDirectory(root, pattern);
  const matches = await artifactMatches(directory, basename(pattern));
  const path = selectedArtifact(directory, matches);
  const resolved = await resolveArtifact(root, path);
  return {
    path: relative(root, resolved),
    content: await readFile(resolved, "utf8"),
  };
}
