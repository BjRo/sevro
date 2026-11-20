import { evaluationProtectedRoots } from "./isolation-roots";
import { dirname, isAbsolute } from "node:path";
import { isMissingFile } from "../kernel/index";
import { mkdir, realpath } from "node:fs/promises";
import {
  requireNativeTranscriptViews,
  requireNativeHookRoots,
  requireCandidateArtifactRoots,
  requireWritableCacheRoots,
  requireRuntimeReadRoots,
  runtimeSeedSources,
  runtimeLocalHttpEnabled,
  sharedCacheDenyRoots,
  sharedCacheRoots,
  type RuntimePolicy,
  type RuntimeRole,
  type CandidateArtifactRoots,
} from "../runtime/index";
import {
  commandRuntimeRoot,
  requireDisjointState,
  requireIsolationPaths,
} from "./isolation-common";

export interface IsolationOptions extends IsolationDescription {
  argv: string[];
}

/** What to protect, by purpose; resolve it with `evaluationProtectedRoots`. */
export type IsolationProtection = Omit<
  Parameters<typeof evaluationProtectedRoots>[0],
  "workspace"
>;

export type IsolationNetwork = "deny" | "local-http" | "allowed";

/** Describe access by purpose; renderers preserve the native precedence of each grant. */
export interface IsolationDescription {
  runtimePolicy?: RuntimePolicy;
  runtimeRole?: RuntimeRole;
  subject?: "command" | "host" | "hook";
  commandHome?: string;
  commandTemp?: string;
  executableReadRoots?: string[];
  pluginReadRoots?: string[];
  nativeReadRoots?: string[];
  nativeWriteRoots?: string[];
  workspace: string;
  /**
   * Resolved protected roots; the policy adds the runtime policy's seed
   * sources. Host policies use them as given; other subjects canonicalize them.
   */
  protectedRoots: string[];
  privateStateRoot: string;
  network?: IsolationNetwork;
  readOnlyRoots?: string[];
  transcriptReadRoots?: string[];
  candidateArtifactRoots?: CandidateArtifactRoots;
  hookReadRoots?: string[];
  writableRuntimeRoot?: string;
  writableCacheRoots?: string[];
}

/** A validated isolation policy. Arrays retain declaration order within each grant. */
export interface IsolationPolicy {
  subject: "command" | "host" | "hook";
  workspace: string;
  privateStateRoot: string;
  deny: string[];
  read: {
    runtime: string[];
    transcripts: string[];
    artifacts: string[];
    hooks: string[];
    plugins: string[];
    executables: string[];
    native: string[];
  };
  write: {
    runtime: string | undefined;
    caches: string[];
    native: string[];
    home: string | undefined;
    temp: string | undefined;
  };
  network: IsolationNetwork;
  runtimeDeclared: boolean;
  hooksEnabled: boolean;
  hideProcessInfo: boolean;
}

/** Validate and canonicalize once, before any policy renderer or sandbox launch. */
export async function createIsolationPolicy(
  description: IsolationDescription,
): Promise<IsolationPolicy> {
  if (description.subject !== "host") await requireCuratedGrants(description);
  const roots = policyProtection(description);
  const resolved = { ...description, protectedRoots: roots };
  if (description.subject === "host") requireHostPaths(resolved);
  requireIsolationPaths(resolved);
  const paths = await policyPaths(resolved);
  const { workspace, privateStateRoot, runtime, deny } = paths;
  const caches = await policyCaches(description, deny);
  const read = runtimeReadGrants(description);
  requireRuntimeReadRoots(read, deny);
  return {
    ...policyIdentity(description),
    workspace,
    privateStateRoot,
    deny,
    read: {
      runtime: read,
      ...curatedReadGrants(description),
      ...hostReadGrants(description),
    },
    write: {
      runtime,
      caches,
      native: description.nativeWriteRoots ?? [],
      home: description.commandHome,
      temp: description.commandTemp,
    },
  };
}

function policyIdentity(description: IsolationDescription) {
  return {
    subject: description.subject ?? "command",
    network: policyNetwork(description),
    runtimeDeclared: description.runtimePolicy !== undefined,
    hooksEnabled: policyHooksEnabled(description.runtimePolicy),
    hideProcessInfo: description.subject === "hook",
  };
}

function runtimeReadGrants(description: IsolationDescription): string[] {
  return [
    ...(description.runtimePolicy?.readOnlyRoots ?? []),
    ...(description.readOnlyRoots ?? []),
  ];
}

function curatedReadGrants(description: IsolationDescription) {
  return {
    transcripts: description.transcriptReadRoots ?? [],
    artifacts: Object.values(description.candidateArtifactRoots ?? {}),
    hooks: description.hookReadRoots ?? [],
  };
}

function hostReadGrants(description: IsolationDescription) {
  return {
    plugins: description.pluginReadRoots ?? [],
    executables: description.executableReadRoots ?? [],
    native: description.nativeReadRoots ?? [],
  };
}

async function policyCaches(
  description: IsolationDescription,
  deny: string[],
): Promise<string[]> {
  return [
    ...(await requireWritableCacheRoots(
      description.writableCacheRoots ?? [],
      deny,
    )),
    ...(await sharedCacheRoots(
      description.runtimePolicy,
      description.runtimeRole,
      deny,
    )),
  ];
}

async function policyPaths(
  description: IsolationDescription & { protectedRoots: string[] },
) {
  if (description.subject === "host") {
    return {
      workspace: description.workspace,
      privateStateRoot: description.privateStateRoot,
      runtime: description.writableRuntimeRoot,
      deny: [...new Set(description.protectedRoots)],
    };
  }
  const workspace = await realpath(description.workspace);
  const roots = await Promise.all(
    description.protectedRoots.map(canonicalProtectedRoot),
  );
  await mkdir(description.privateStateRoot, { recursive: true, mode: 0o700 });
  const privateStateRoot = await realpath(description.privateStateRoot);
  const runtime = await commandRuntimeRoot(
    privateStateRoot,
    description.writableRuntimeRoot,
  );
  requireDisjointState(workspace, roots, privateStateRoot);
  return {
    workspace,
    privateStateRoot,
    runtime,
    deny: [
      ...new Set(
        description.subject === "hook" ? roots : [...roots, privateStateRoot],
      ),
    ],
  };
}

function requireHostPaths(
  description: IsolationDescription & { protectedRoots: string[] },
): void {
  requireHostReadGrants(description);
  if (description.commandHome === undefined) return;
  if (
    !validCommandPaths(description) ||
    !description.protectedRoots.length ||
    !description.protectedRoots.every(isAbsolute)
  )
    throw new Error("host isolation paths must be absolute and protected");
}

function validCommandPaths(description: IsolationDescription): boolean {
  return (
    [
      description.workspace,
      description.commandHome ?? "",
      description.commandTemp ?? "",
    ].every(isAbsolute) && Boolean(description.executableReadRoots?.length)
  );
}

async function requireCuratedGrants(
  description: IsolationDescription,
): Promise<void> {
  await requireNativeTranscriptViews(description.transcriptReadRoots);
  await requireCandidateArtifactRoots(description.candidateArtifactRoots);
  await requireNativeHookRoots(
    description.hookReadRoots,
    description.privateStateRoot,
  );
}

function policyNetwork(description: IsolationDescription): IsolationNetwork {
  if (description.network === "allowed") return "allowed";
  return runtimeLocalHttpEnabled(
    description.runtimePolicy,
    description.runtimeRole ?? "candidate",
  )
    ? "local-http"
    : (description.network ?? "allowed");
}

function policyHooksEnabled(policy: RuntimePolicy | undefined): boolean {
  const hooks = policy?.hooks;
  if (!hooks) return false;
  return hooks.nativeGoal === true || (hooks.plugins ?? []).length > 0;
}

/**
 * A peer may remove its workspace after its roots were resolved. A missing root
 * stays denied as given only when its parent is canonical, so it is no alias.
 */
async function canonicalProtectedRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (cause) {
    if (
      !isMissingFile(cause) ||
      (await realpath(dirname(path))) !== dirname(path)
    )
      throw cause;
    return path;
  }
}

function policyProtection(description: IsolationDescription): string[] {
  return [
    ...description.protectedRoots,
    ...runtimeSeedSources(description.runtimePolicy),
    ...sharedCacheDenyRoots(description.runtimePolicy, description.runtimeRole),
  ];
}

function requireHostReadGrants(description: IsolationDescription): void {
  const grants = [
    ...(description.executableReadRoots ?? []),
    ...(description.pluginReadRoots ?? []),
  ];
  if (!grants.every(boundedHostReadGrant))
    throw new Error("host isolation paths must be absolute and protected");
}

function boundedHostReadGrant(path: string): boolean {
  return isAbsolute(path) && path !== "/";
}
