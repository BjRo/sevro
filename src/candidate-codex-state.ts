import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { userInfo } from "node:os";
import { nativeStatePath } from "./native-transcript-state";
import { clearFixtureContents } from "./fixture-cleanup";
import type { RuntimePolicy } from "./runtime-config";

interface CodexPaths {
  codexHome: string;
  parentHome: string;
  commandHome: string;
}
interface ArtifactBinding {
  root: string;
  path: string;
  directoryPath: string;
  file?: boolean;
}
interface CodexLease {
  state?: { stateRoot: string; artifacts: Record<string, ArtifactBinding> };
}
const leases = new Map<string, CodexLease>();
const ARTIFACT_NAMES = [
  "codex_config",
  "codex_skills",
  "agent_skills",
  "command_agent_skills",
  "command_codex_skills",
];

export function codexStateEnabled(policy: RuntimePolicy | undefined): boolean {
  return policy?.codexState === true;
}

export function requireUnreservedArtifactName(name: string): void {
  if (ARTIFACT_NAMES.includes(name))
    throw new Error(
      "runtime artifact directory name is reserved for Codex state",
    );
}

export function allocateCodexStateLease(root: string, enabled: boolean): void {
  if (enabled) leases.set(root, {});
}

/** Bind the actual host state to one trial before execution; never substitute a grader home. */
export async function retainCandidateCodexState(
  runtimeRoot: string | undefined,
  stateRoot: string,
  paths: CodexPaths,
): Promise<void> {
  if (runtimeRoot === undefined) return;
  const lease = leases.get(runtimeRoot);
  if (!lease) return;
  if (lease.state)
    throw new Error(
      "candidate Codex state is already bound to a native request",
    );
  requireCodexLayout(stateRoot, runtimeRoot, paths);
  await requirePrivateState(stateRoot);
  await requirePrivateState(paths.codexHome);
  lease.state = {
    stateRoot,
    artifacts: codexArtifacts(stateRoot, runtimeRoot, paths),
  };
}

function requireCodexLayout(
  stateRoot: string,
  runtimeRoot: string,
  paths: CodexPaths,
): void {
  if (
    dirname(stateRoot) !== nativeStatePath() ||
    !basename(stateRoot).startsWith("codex-")
  )
    throw new Error("candidate Codex state must be a native request directory");
  requireCodexHomes(stateRoot, runtimeRoot, paths);
}

function requireCodexHomes(
  stateRoot: string,
  runtimeRoot: string,
  paths: CodexPaths,
): void {
  if (
    paths.codexHome !== join(stateRoot, "codex-home") ||
    paths.parentHome !== join(stateRoot, "home") ||
    paths.commandHome !== join(runtimeRoot, "home")
  )
    throw new Error("candidate Codex homes must belong to the current trial");
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
      "candidate Codex state must be owned, private and canonical",
    );
}

function binding(root: string, path: string, file = false): ArtifactBinding {
  return {
    root,
    path,
    directoryPath: relative(root, file ? dirname(path) : path),
    file,
  };
}

function codexArtifacts(
  stateRoot: string,
  runtimeRoot: string,
  paths: CodexPaths,
): Record<string, ArtifactBinding> {
  return {
    codex_config: binding(
      stateRoot,
      join(paths.codexHome, "config.toml"),
      true,
    ),
    codex_skills: binding(stateRoot, join(paths.codexHome, "skills")),
    agent_skills: binding(
      stateRoot,
      join(paths.parentHome, ".agents", "skills"),
    ),
    command_agent_skills: binding(
      runtimeRoot,
      join(paths.commandHome, ".agents", "skills"),
    ),
    command_codex_skills: binding(
      runtimeRoot,
      join(paths.commandHome, ".codex", "skills"),
    ),
  };
}

export function candidateCodexArtifactRoots(
  root: string,
): Record<string, string> {
  const lease = leases.get(root);
  if (!lease) return {};
  if (!lease.state) throw new Error("candidate Codex state is unavailable");
  return Object.fromEntries(
    Object.entries(lease.state.artifacts).map(([name, item]) => [
      name,
      item.path,
    ]),
  );
}

export function candidateCodexArtifactBinding(
  name: string,
  path: string,
): ArtifactBinding | undefined {
  for (const lease of leases.values()) {
    const artifact = lease.state?.artifacts[name];
    if (artifact?.path === path) return artifact;
  }
  return undefined;
}

export function candidateCodexStateRetained(
  runtimeRoot: string | undefined,
  stateRoot: string,
): boolean {
  return (
    runtimeRoot !== undefined &&
    leases.get(runtimeRoot)?.state?.stateRoot === stateRoot
  );
}

export async function releaseCandidateCodexState(root: string): Promise<void> {
  const state = leases.get(root)?.state;
  if (state) {
    await clearFixtureContents(state.stateRoot);
    await rm(state.stateRoot, { recursive: true, force: true });
  }
  leases.delete(root);
}
