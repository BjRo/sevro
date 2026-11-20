/**
 * The role environment: the runtime directories and base environment Sevro
 * gives an isolated process for its runtime role, before a host adds its own
 * settings. It owns the undeclared-policy layouts, PATH composition with each
 * process kind's fallback, the UV block and the candidate grant variables.
 */
import { mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { prepareRuntimeState } from "./state";
import {
  candidateArtifactEnvironment,
  candidateArtifactReadRoots,
  type CandidateArtifactRoots,
} from "./candidate-artifacts";
import type { RuntimePolicy, RuntimeRole } from "./policy";

/** The runtime policy in effect when a project declares none. */
export function undeclaredRuntimePolicy(): RuntimePolicy {
  return { format: "sevro.runtime.v1", environment: {}, readOnlyRoots: [] };
}

/**
 * What kind of process a PATH is for. Each keeps its fallback for runtime
 * policies that declare no PATH: a native host inherits the runner's PATH, a
 * native host's own commands get the common tool locations, and checks and
 * hooks get only the system directories.
 */
export type RoleProcess = "native-host" | "host-command" | "command";

function fallbackPath(kind: RoleProcess): string {
  if (kind === "native-host") return process.env.PATH ?? "/usr/bin:/bin";
  return kind === "host-command"
    ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    : "/usr/bin:/bin:/usr/sbin:/sbin";
}

/** Fixture tools first, then the toolchain, then the declared or fallback PATH. */
export function rolePath(
  kind: RoleProcess,
  directories: {
    fixtureBinDir?: string | null;
    toolchainBinDir?: string | null;
    declared?: string;
  },
): string {
  return [
    directories.fixtureBinDir,
    directories.toolchainBinDir,
    directories.declared ?? fallbackPath(kind),
  ]
    .filter(Boolean)
    .join(delimiter);
}

/** Offline UV with a private cache and project environment. */
export function uvRuntimeEnvironment(
  runtimeRoot: string,
  cache: string,
): Record<string, string> {
  return {
    UV_CACHE_DIR: cache,
    UV_PROJECT_ENVIRONMENT: join(runtimeRoot, "project-environment"),
    UV_OFFLINE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

/** The candidate's evidence a grader or judge host may read. */
export interface CandidateGrants {
  artifactRoots?: CandidateArtifactRoots;
  transcriptRoot?: string;
}

export function candidateTranscriptReadRoots(root: string | undefined) {
  return root ? [root] : [];
}

export function candidateGrantEnvironment(
  grants: CandidateGrants,
): Record<string, string> {
  return {
    ...(grants.transcriptRoot
      ? { SEVRO_CANDIDATE_TRANSCRIPTS: grants.transcriptRoot }
      : {}),
    ...candidateArtifactEnvironment(grants.artifactRoots),
  };
}

export function candidateGrantReadRoots(grants: CandidateGrants): string[] {
  return [
    ...candidateTranscriptReadRoots(grants.transcriptRoot),
    ...candidateArtifactReadRoots(grants.artifactRoots),
  ];
}

export interface RoleRuntime {
  /** Whether a runtime policy was declared; otherwise the legacy layout applies. */
  declared: boolean;
  root: string;
  home: string;
  temp: string;
  /** The declared environment with HOME and TMPDIR; empty for legacy checks. */
  environment: Record<string, string>;
  writableCacheRoots: string[];
  /** Where an opted-in UV cache for this role lives. */
  uvCache: string;
}

/** Prepare a role's runtime directories, declared or legacy. */
export async function prepareRoleRuntime(options: {
  workspace: string;
  policy: RuntimePolicy | undefined;
  role: RuntimeRole;
  root?: string;
}): Promise<RoleRuntime> {
  const { workspace, policy, role, root } = options;
  if (policy) {
    const runtime = await prepareRuntimeState(workspace, policy, role, root);
    return {
      ...runtime,
      declared: true,
      uvCache: join(runtime.root, "uv-cache"),
    };
  }
  if (role === "checks" && root !== undefined)
    return legacyCheckRuntime(workspace, root);
  const runtime = await prepareRuntimeState(
    workspace,
    undeclaredRuntimePolicy(),
    role,
    root,
  );
  return {
    ...runtime,
    declared: false,
    uvCache: join(runtime.root, "uv-cache"),
  };
}

/** Checks without a runtime policy keep their original private layout. */
async function legacyCheckRuntime(
  workspace: string,
  root: string,
): Promise<RoleRuntime> {
  const home = join(root, "check-home"),
    temp = join(root, "check-tmp");
  await Promise.all(
    [home, temp].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  return {
    declared: false,
    root,
    home,
    temp,
    environment: {},
    writableCacheRoots: [],
    uvCache: join(workspace, ".git", "sevro-runtime", "uv-cache"),
  };
}

/** A command's complete base environment: runtime, grants, PATH, homes, UV. */
export async function prepareRoleEnvironment(options: {
  workspace: string;
  policy: RuntimePolicy | undefined;
  role: RuntimeRole;
  root?: string;
  fixtureBinDir?: string;
  toolchainBinDir?: string;
  uvRuntimeCache?: boolean;
  candidate?: CandidateGrants;
}): Promise<{ runtime: RoleRuntime; environment: Record<string, string> }> {
  const runtime = await prepareRoleRuntime(options);
  return {
    runtime,
    environment: {
      ...runtime.environment,
      ...candidateGrantEnvironment(options.candidate ?? {}),
      PATH: rolePath("command", {
        fixtureBinDir: options.fixtureBinDir,
        toolchainBinDir: options.toolchainBinDir,
        declared: runtime.environment.PATH,
      }),
      HOME: runtime.home,
      TMPDIR: runtime.temp,
      LANG: process.env.LANG ?? "C",
      ...(options.uvRuntimeCache
        ? uvRuntimeEnvironment(runtime.root, runtime.uvCache)
        : {}),
    },
  };
}
