import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  allocateCodexStateLease,
  candidateCodexArtifactBinding,
  candidateCodexArtifactRoots,
  codexStateEnabled,
  releaseCandidateCodexState,
} from "./candidate-codex-state";
import {
  allocateNativeState,
  nativeStatePath,
} from "./native-transcript-state";
import {
  requireArtifactDirectories,
  type RuntimeArtifactDirectory,
  type RuntimePolicy,
  type RuntimeRole,
} from "./runtime/index";
import { clearFixtureContents } from "./workspace/index";

export type CandidateArtifactRoots = Record<string, string>;

const leases = new Map<string, RuntimeArtifactDirectory[]>();
const MAX_ENTRIES = 16_384;

/** Allocate before host execution so exceptions cannot lose cleanup ownership. */
export async function allocateCandidateRuntime(
  policy: RuntimePolicy | undefined,
  retainHome = false,
): Promise<string | undefined> {
  const directories = policy?.artifactDirectories ?? [];
  const codexState = codexStateEnabled(policy);
  if (!candidateRuntimeRequired(directories, codexState, retainHome))
    return undefined;
  requireArtifactDirectories(directories);
  const root = await allocateNativeState("candidate-runtime-");
  leases.set(root, directories);
  allocateCodexStateLease(root, codexState);
  return root;
}

function candidateRuntimeRequired(
  directories: RuntimeArtifactDirectory[],
  codexState: boolean,
  retainHome: boolean,
): boolean {
  return directories.length > 0 || codexState || retainHome;
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
