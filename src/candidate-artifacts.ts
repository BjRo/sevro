import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  allocateCodexStateLease,
  candidateCodexArtifactBinding,
  candidateCodexArtifactRoots,
  codexStateEnabled,
  releaseCandidateCodexState,
  requireUnreservedArtifactName,
} from "./candidate-codex-state";
import {
  allocateNativeState,
  nativeStatePath,
} from "./native-transcript-state";
import type { RuntimePolicy, RuntimeRole } from "./runtime/config";
import { clearFixtureContents } from "./fixtures/cleanup";

export interface RuntimeArtifactDirectory {
  name: string;
  path: string;
}

export type CandidateArtifactRoots = Record<string, string>;

const leases = new Map<string, RuntimeArtifactDirectory[]>();
const MAX_ENTRIES = 16_384;

/** These are relative candidate-home paths, never operator filesystem grants. */
export function requireArtifactDirectories(
  directories: RuntimeArtifactDirectory[],
): void {
  if (!Array.isArray(directories) || directories.length > 16)
    throw new Error("runtime artifact directories exceed the limit");
  const names = new Set<string>();
  for (const directory of directories) {
    requireArtifactDirectory(directory);
    if (names.has(directory.name))
      throw new Error("runtime artifact directory names overlap");
    names.add(directory.name);
  }
}

function requireArtifactDirectory(directory: RuntimeArtifactDirectory): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(directory.name))
    throw new Error("runtime artifact directory name is invalid");
  requireUnreservedArtifactName(directory.name);
  const path = directory.path;
  if (!validArtifactPath(path))
    throw new Error("runtime artifact directory path is invalid");
  if (path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error(
      "runtime artifact directory must be a bounded relative path",
    );
}

function validArtifactPath(path: string): boolean {
  if (typeof path !== "string" || path.length > 4096 || path.includes("\\"))
    return false;
  return !Array.from(path).some(
    (character) =>
      character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
  );
}

/** Allocate before host execution so exceptions cannot lose cleanup ownership. */
export async function allocateCandidateRuntime(
  policy: RuntimePolicy | undefined,
): Promise<string | undefined> {
  const directories = policy?.artifactDirectories ?? [];
  const codexState = codexStateEnabled(policy);
  if (!directories.length && !codexState) return undefined;
  requireArtifactDirectories(directories);
  const root = await allocateNativeState("candidate-runtime-");
  leases.set(root, directories);
  allocateCodexStateLease(root, codexState);
  return root;
}

export async function requireCandidateRuntime(
  root: string | undefined,
  role?: RuntimeRole,
): Promise<void> {
  if (root === undefined) return;
  requireCandidateRole(role);
  if (!leases.has(root) || (await realpath(root)) !== root)
    throw new Error("candidate runtime must be owned by the current trial");
}

function requireCandidateRole(role: RuntimeRole | undefined): void {
  if (role !== undefined && role !== "candidate")
    throw new Error(
      "retained candidate runtime cannot be used by another role",
    );
}

export async function candidateArtifactRoots(
  root: string | undefined,
): Promise<CandidateArtifactRoots | undefined> {
  if (root === undefined) return undefined;
  const directories = leases.get(root);
  if (!directories) throw new Error("candidate runtime lease is unavailable");
  const roots = Object.fromEntries(
    directories.map(({ name, path }) => [name, join(root, "home", path)]),
  );
  Object.assign(roots, candidateCodexArtifactRoots(root));
  await requireCandidateArtifactRoots(roots);
  return roots;
}

/** Validate the engine binding and refuse candidate-created filesystem aliases. */
export async function requireCandidateArtifactRoots(
  roots: CandidateArtifactRoots | undefined,
): Promise<void> {
  for (const [name, path] of Object.entries(roots ?? {})) {
    const binding = artifactRootBinding(name, path);
    await requireArtifactAncestors(binding.root, binding.directoryPath);
    if (binding.file && !(await lstat(path)).isFile())
      throw new Error(
        "candidate Codex configuration must remain a regular file",
      );
    await requireArtifactTree(path);
  }
}

function artifactRootBinding(name: string, path: string) {
  const codex = candidateCodexArtifactBinding(name, path);
  if (codex) return codex;
  return homeArtifactBinding(name, path);
}

function homeArtifactBinding(name: string, path: string) {
  const parts = relative(nativeStatePath(), path).split(sep);
  const root = join(nativeStatePath(), parts[0] ?? "");
  const directory = leases.get(root)?.find((item) => item.name === name);
  if (!directory || path !== join(root, "home", directory.path))
    throw new Error("candidate artifact grant is not bound to an active trial");
  return { root, directoryPath: join("home", directory.path), file: false };
}

async function requireArtifactAncestors(
  root: string,
  path: string,
): Promise<void> {
  let current = root;
  for (const part of ["", ...path.split(sep)]) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || (await realpath(current)) !== current)
      throw new Error(
        "candidate artifact ancestors must be canonical directories",
      );
  }
}

async function requireArtifactTree(root: string): Promise<void> {
  const pending = [root];
  for (const path of pending) {
    if (pending.length > MAX_ENTRIES)
      throw new Error("candidate artifact tree exceeds the entry limit");
    pending.push(...(await artifactChildren(path)));
  }
}

async function artifactChildren(path: string): Promise<string[]> {
  const info = await lstat(path);
  if (info.isDirectory())
    return (await readdir(path)).map((name) => join(path, name));
  if (!info.isFile() || info.nlink !== 1)
    throw new Error("candidate artifact tree contains a link or special file");
  return [];
}

export function candidateArtifactEnvironment(
  roots: CandidateArtifactRoots | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(roots ?? {}).map(([name, path]) => [
      `SEVRO_CANDIDATE_ARTIFACT_${name.toUpperCase()}`,
      path,
    ]),
  );
}

export function candidateArtifactReadRoots(
  roots: CandidateArtifactRoots | undefined,
): string[] {
  return Object.values(roots ?? {});
}

export async function releaseCandidateRuntime(
  root: string | undefined,
): Promise<void> {
  if (root === undefined) return;
  await releaseCandidateCodexState(root);
  await clearFixtureContents(root);
  await rm(root, { recursive: true, force: true });
  leases.delete(root);
}
