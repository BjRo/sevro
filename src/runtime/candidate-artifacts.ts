import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import {
  allocateNativeState,
  nativeStatePath,
} from "./native-transcript-state";
import {
  requireArtifactDirectories,
  type RuntimeArtifactDirectory,
} from "./artifact-directories";
import type { RuntimePolicy, RuntimeRole } from "./policy";
import { clearWorkspaceContents } from "../workspace/index";

export type CandidateArtifactRoots = Record<string, string>;

/** One candidate artifact a host names inside its retained private state. */
export interface CandidateArtifactPath {
  path: string;
  file?: boolean;
}

interface ArtifactBinding {
  root: string;
  path: string;
  directoryPath: string;
  file: boolean;
}

interface RetainedPrivateState {
  stateRoot: string;
  artifacts: Record<string, ArtifactBinding>;
}

interface CandidateRuntimeLease {
  directories: RuntimeArtifactDirectory[];
  retainsPrivateState: boolean;
  privateState?: RetainedPrivateState;
}

const leases = new Map<string, CandidateRuntimeLease>();
const MAX_ENTRIES = 16_384;

/** Allocate before host execution so exceptions cannot lose cleanup ownership. */
export async function allocateCandidateRuntime(
  policy: RuntimePolicy | undefined,
  retainHome = false,
): Promise<string | undefined> {
  const directories = policy?.artifactDirectories ?? [];
  const retainsPrivateState = privateStateRetentionSelected(policy);
  if (!candidateRuntimeRequired(directories, retainsPrivateState, retainHome))
    return undefined;
  requireArtifactDirectories(directories);
  const root = await allocateNativeState("candidate-runtime-");
  leases.set(root, { directories, retainsPrivateState });
  return root;
}

/** `codexState` is the runtime contract's only private-state retention opt-in. */
function privateStateRetentionSelected(
  policy: RuntimePolicy | undefined,
): boolean {
  return policy?.codexState === true;
}

function candidateRuntimeRequired(
  directories: RuntimeArtifactDirectory[],
  retainsPrivateState: boolean,
  retainHome: boolean,
): boolean {
  return directories.length > 0 || retainsPrivateState || retainHome;
}

/**
 * Keep one native host request's private state for grading and expose the
 * named candidate artifacts inside it. Does nothing unless the trial's
 * candidate runtime retains private state; never substitute a grader home.
 */
export async function retainCandidatePrivateState(
  runtimeRoot: string | undefined,
  stateRoot: string,
  artifacts: Record<string, CandidateArtifactPath>,
): Promise<void> {
  if (runtimeRoot === undefined) return;
  const lease = leases.get(runtimeRoot);
  if (!lease?.retainsPrivateState) return;
  await requireUnboundPrivateState(lease, stateRoot);
  lease.privateState = {
    stateRoot,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([name, artifact]) => [
        name,
        retainedBinding(stateRoot, runtimeRoot, artifact),
      ]),
    ),
  };
}

/** Whether the native host request's private state outlives that request. */
export function candidatePrivateStateRetained(
  runtimeRoot: string | undefined,
  stateRoot: string,
): boolean {
  return (
    runtimeRoot !== undefined &&
    leases.get(runtimeRoot)?.privateState?.stateRoot === stateRoot
  );
}

async function requireUnboundPrivateState(
  lease: CandidateRuntimeLease,
  stateRoot: string,
): Promise<void> {
  if (lease.privateState)
    throw new Error(
      "candidate private state is already bound to a native request",
    );
  if (dirname(stateRoot) !== nativeStatePath())
    throw new Error(
      "candidate private state must be a native request directory",
    );
  await requirePrivateState(stateRoot);
}

async function requirePrivateState(root: string): Promise<void> {
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.uid !== userInfo().uid ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(root)) !== root
  )
    throw new Error(
      "candidate private state must be owned, private and canonical",
    );
}

function retainedBinding(
  stateRoot: string,
  runtimeRoot: string,
  artifact: CandidateArtifactPath,
): ArtifactBinding {
  const root = [stateRoot, runtimeRoot].find((candidate) =>
    artifact.path.startsWith(`${candidate}${sep}`),
  );
  if (root === undefined)
    throw new Error("candidate artifact must belong to the current trial");
  const file = artifact.file === true;
  return {
    root,
    path: artifact.path,
    directoryPath: relative(
      root,
      file ? dirname(artifact.path) : artifact.path,
    ),
    file,
  };
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
  const lease = leases.get(root);
  if (!lease) throw new Error("candidate runtime lease is unavailable");
  const roots = Object.fromEntries(
    lease.directories.map(({ name, path }) => [name, join(root, "home", path)]),
  );
  Object.assign(roots, retainedArtifactRoots(lease));
  await requireCandidateArtifactRoots(roots);
  return roots;
}

function retainedArtifactRoots(
  lease: CandidateRuntimeLease,
): CandidateArtifactRoots {
  if (!lease.retainsPrivateState) return {};
  if (!lease.privateState)
    throw new Error("candidate private state is unavailable");
  return Object.fromEntries(
    Object.entries(lease.privateState.artifacts).map(([name, item]) => [
      name,
      item.path,
    ]),
  );
}

/** Validate the engine binding and refuse candidate-created filesystem aliases. */
export async function requireCandidateArtifactRoots(
  roots: CandidateArtifactRoots | undefined,
): Promise<void> {
  for (const [name, path] of Object.entries(roots ?? {})) {
    const binding = artifactRootBinding(name, path);
    await requireArtifactAncestors(binding.root, binding.directoryPath);
    if (binding.file && !(await lstat(path)).isFile())
      throw new Error("candidate artifact file must remain a regular file");
    await requireArtifactTree(path);
  }
}

function artifactRootBinding(name: string, path: string) {
  return retainedArtifactBinding(name, path) ?? homeArtifactBinding(name, path);
}

function retainedArtifactBinding(
  name: string,
  path: string,
): ArtifactBinding | undefined {
  for (const lease of leases.values()) {
    const artifact = lease.privateState?.artifacts[name];
    if (artifact?.path === path) return artifact;
  }
  return undefined;
}

function homeArtifactBinding(name: string, path: string) {
  const parts = relative(nativeStatePath(), path).split(sep);
  const root = join(nativeStatePath(), parts[0] ?? "");
  const directory = leases
    .get(root)
    ?.directories.find((item) => item.name === name);
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
  const privateState = leases.get(root)?.privateState;
  if (privateState) {
    await clearWorkspaceContents(privateState.stateRoot);
    await rm(privateState.stateRoot, { recursive: true, force: true });
  }
  await clearWorkspaceContents(root);
  await rm(root, { recursive: true, force: true });
  leases.delete(root);
}
