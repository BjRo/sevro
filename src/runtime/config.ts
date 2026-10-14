import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  declaredRuntimeRoots,
  optionalRuntimeRoots,
  runtimePathDirectories,
  runtimeInheritedPath,
  requireRuntimeReadRoots,
} from "./paths";
import validate from "../generated/runtime.cjs";
import {
  requireArtifactDirectories,
  type RuntimeArtifactDirectory,
} from "../candidate-artifacts";
import { runtimeSeedDigest } from "./seeds";
import {
  discoverRuntimeSupport,
  type RuntimeDiscoverySource,
} from "./discovery";

export type RuntimeRole =
  "candidate" | "checks" | "hooks" | "semantic" | "advisory";
export interface RuntimeSeed {
  source: string;
  target: string;
  roles?: RuntimeRole[];
}
export interface RuntimeConfiguration {
  format: "sevro.runtime.v1";
  codexState?: boolean;
  network?: { localHttp?: boolean };
  nativeTranscripts?: boolean;
  environment?: { inherit?: string[]; set?: Record<string, string> };
  filesystem?: { readOnlyRoots?: string[]; optionalReadOnlyRoots?: string[] };
  runtime?: {
    seedDirectories?: RuntimeSeed[];
    artifactDirectories?: RuntimeArtifactDirectory[];
  };
  hooks?: { nativeGoal?: boolean; plugins?: string[] };
}

export interface RuntimePolicy {
  format: "sevro.runtime.v1";
  codexState?: boolean;
  network?: { localHttp?: boolean };
  artifactDirectories?: RuntimeArtifactDirectory[];
  nativeTranscripts?: boolean;
  environment: Record<string, string>;
  readOnlyRoots: string[];
  discovery?: RuntimeDiscoverySource[];
  skippedOptionalReadOnlyRoots?: string[];
  /** Original source denials retained when a derived role policy omits seeds. */
  seedReadDenyRoots?: string[];
  seeds?: (RuntimeSeed & { sha256: string })[];
  hooks?: { nativeGoal?: boolean; plugins?: string[] };
}

export function runtimeLocalHttpEnabled(
  policy: RuntimePolicy | undefined,
  role: RuntimeRole,
): boolean {
  const network = policy?.network;
  return network?.localHttp === true && ["candidate", "checks"].includes(role);
}

export function runtimeNativeGoalEnabled(
  policy: RuntimePolicy | undefined,
): boolean {
  const hooks = policy?.hooks;
  return hooks?.nativeGoal === true;
}

export function runtimePolicySnapshot(
  policy: RuntimePolicy | undefined,
): RuntimePolicy | undefined {
  if (!policy) return undefined;
  requireRuntimeEnvironment(policy.environment);
  const snapshot = structuredClone(policy);
  Object.freeze(snapshot.network);
  freezeArtifactDirectories(snapshot);
  Object.freeze(snapshot.environment);
  Object.freeze(snapshot.readOnlyRoots);
  freezeDiscovery(snapshot);
  for (const seed of snapshot.seeds ?? []) {
    Object.freeze(seed.roles);
    Object.freeze(seed);
  }
  Object.freeze(snapshot.seeds);
  Object.freeze(snapshot.seedReadDenyRoots);
  const hooks = snapshot.hooks;
  if (hooks) {
    Object.freeze(hooks.plugins);
    Object.freeze(hooks);
  }
  return Object.freeze(snapshot);
}

function freezeDiscovery(snapshot: RuntimePolicy): void {
  for (const source of snapshot.discovery ?? []) {
    Object.freeze(source.readOnlyRoots);
    Object.freeze(source);
  }
  Object.freeze(snapshot.discovery);
  Object.freeze(snapshot.skippedOptionalReadOnlyRoots);
}

function freezeArtifactDirectories(snapshot: RuntimePolicy): void {
  const directories = snapshot.artifactDirectories ?? [];
  requireArtifactDirectories(directories);
  for (const directory of directories) Object.freeze(directory);
  Object.freeze(snapshot.artifactDirectories);
}

function assertRuntimeConfiguration(
  value: unknown,
): asserts value is RuntimeConfiguration {
  if (!validate(value)) throw new Error("invalid runtime configuration schema");
}

const RESERVED_ENVIRONMENT =
  /^(HOME|TMPDIR|TMP|TEMP|CODEX_HOME|CODEX_THREAD_ID|CLAUDE_CONFIG_DIR|CLAUDE_EFFORT|BASH_ENV|ENV|ZDOTDIR|NODE_OPTIONS|BUN_OPTIONS|UV_OFFLINE|GIT_CONFIG.*|LD_.*|DYLD_.*|CLAUDE_CODE_.*|SEVRO_CODEX_.*|SEVRO_NATIVE_.*|SEVRO_CANDIDATE_.*)$/i;

function requireEnvironmentName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
    throw new Error("invalid runtime environment variable name");
  if (
    RESERVED_ENVIRONMENT.test(name) ||
    /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(name)
  )
    throw new Error(`runtime environment variable is protected: ${name}`);
}

function snapshotEnvironment(
  names: string[],
  values: Record<string, string>,
): Record<string, string> {
  const inherited = Object.fromEntries(
    names.map((name) => {
      requireEnvironmentName(name);
      const value = process.env[name];
      if (value === undefined)
        throw new Error(`runtime environment variable is missing: ${name}`);
      return [name, value];
    }),
  );
  const environment = { ...inherited, ...values };
  for (const [name, value] of Object.entries(environment)) {
    requireEnvironmentName(name);
    if (value.includes("\0") || Buffer.byteLength(value) > 8192)
      throw new Error("runtime environment value is invalid or oversized");
  }
  return environment;
}

export function requireRuntimeEnvironment(
  environment: Record<string, string>,
): void {
  snapshotEnvironment([], environment);
}

export function requireRuntimeSeedTargets(
  seeds: NonNullable<RuntimePolicy["seeds"]>,
): void {
  for (const seed of seeds) requireRuntimeSeedRoles(seed.roles);
  const targets = seeds.map((seed) => seed.target);
  if (
    targets.some(
      (target) =>
        !/^[a-z][a-z0-9-]{0,63}$/.test(target) ||
        ["home", "tmp"].includes(target),
    )
  )
    throw new Error("runtime seed target is invalid or reserved");
  if (new Set(targets).size !== targets.length)
    throw new Error("runtime seed targets overlap");
}

/** Read the operator's repository configuration before any candidate starts. */
export async function loadRuntimeConfiguration(
  projectRoot: string,
  explicitFile?: string,
  protectedRoots: string[] = [],
): Promise<RuntimePolicy | undefined> {
  const path = await selectedRuntimeFile(projectRoot, explicitFile);
  if (path === undefined) return undefined;
  try {
    const canonical = await realpath(path);
    const source = await readFile(canonical, "utf8");
    if (Buffer.byteLength(source) > 65536)
      throw new Error("runtime configuration exceeds 64 KiB");
    return await resolveRuntimeConfiguration(
      JSON.parse(source),
      dirname(canonical),
      protectedRoots,
    );
  } catch (cause) {
    throw new Error(runtimeConfigurationDiagnostic(cause), { cause });
  }
}

function runtimeConfigurationDiagnostic(cause: unknown): string {
  if (
    cause instanceof Error &&
    /^(runtime |declared runtime |selected Apple )/.test(cause.message)
  )
    return `invalid runtime configuration: ${cause.message}`;
  const filesystem = runtimeFilesystemDiagnostic(cause);
  if (filesystem) return filesystem;
  return "invalid runtime configuration";
}

function runtimeFilesystemDiagnostic(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const error = cause as NodeJS.ErrnoException;
  if (
    !validFilesystemCode(error.code) ||
    !validFilesystemOperation(error.syscall) ||
    typeof error.path !== "string"
  )
    return undefined;
  const path = safeFilesystemPath(error.path);
  return `invalid runtime configuration: filesystem ${error.syscall} failed (${error.code}) at ${path}`;
}

function validFilesystemCode(code: string | undefined): boolean {
  return code !== undefined && /^E[A-Z0-9]+$/.test(code);
}

function validFilesystemOperation(operation: string | undefined): boolean {
  return operation !== undefined && /^[A-Za-z][A-Za-z0-9_]*$/.test(operation);
}

function safeFilesystemPath(path: string): string {
  return Array.from(path.slice(0, 256), (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "?" : character;
  }).join("");
}

async function selectedRuntimeFile(
  projectRoot: string,
  explicitFile?: string,
): Promise<string | undefined> {
  const path = explicitFile ?? join(projectRoot, "sevro.json");
  const info = await selectedRuntimeStat(path, Boolean(explicitFile));
  if (!info) return undefined;
  if (!info.isFile() || info.size > 65536)
    throw new Error(
      "invalid runtime configuration: expected a regular file up to 64 KiB",
    );
  return path;
}

async function selectedRuntimeStat(path: string, explicit: boolean) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (!explicit && (cause as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw new Error(
      runtimeFilesystemDiagnostic(cause) ?? "invalid runtime configuration",
      { cause },
    );
  }
}

async function resolvedSeeds(
  seeds: RuntimeSeed[],
  environment: Record<string, string>,
  base: string,
) {
  const resolved = await Promise.all(
    seeds.map(async (seed) => {
      const roots = await declaredRuntimeRoots(
        [seed.source],
        environment,
        base,
      );
      requireRuntimeReadRoots(roots, []);
      const [source] = roots;
      if (!source) throw new Error("runtime seed source is missing");
      return {
        source,
        target: seed.target,
        ...(seed.roles ? { roles: seed.roles } : {}),
        sha256: await runtimeSeedDigest(source),
      };
    }),
  );
  requireRuntimeSeedTargets(resolved);
  return resolved;
}

async function resolveRuntimeConfiguration(
  value: unknown,
  base: string,
  protectedRoots: string[],
): Promise<RuntimePolicy> {
  assertRuntimeConfiguration(value);
  const environment = await resolvedRuntimeEnvironment(value);
  const optional = await optionalRuntimeRoots(
    value.filesystem?.optionalReadOnlyRoots ?? [],
    environment,
    base,
    protectedRoots,
  );
  const pathRoots = await runtimePathDirectories(environment.PATH);
  requireRuntimeReadRoots(pathRoots, protectedRoots);
  requireRuntimeReadRoots(optional.roots, protectedRoots);
  const discovery = await discoverRuntimeSupport(environment, protectedRoots);
  const readOnlyRoots = [
    ...optional.roots,
    ...discovery.sources.flatMap((source) => source.readOnlyRoots),
    ...pathRoots.filter((root) => !discovery.excludedPrefixes.includes(root)),
    ...(await declaredRuntimeRoots(
      configurationReadRoots(value),
      environment,
      base,
    )),
  ];
  requireRuntimeReadRoots(readOnlyRoots, protectedRoots);
  return {
    format: value.format,
    ...selectedRuntimeCapabilities(value),
    ...artifactConfiguration(value.runtime),
    environment,
    readOnlyRoots: [...new Set(readOnlyRoots)].sort(),
    discovery: discovery.sources,
    skippedOptionalReadOnlyRoots: optional.skipped,
    seeds: await resolvedSeeds(configurationSeeds(value), environment, base),
    hooks: resolvedHooks(value.hooks),
  };
}

function selectedRuntimeCapabilities(value: RuntimeConfiguration) {
  return {
    ...(value.network === undefined ? {} : { network: value.network }),
    ...(value.codexState === undefined ? {} : { codexState: value.codexState }),
    ...(value.nativeTranscripts === undefined
      ? {}
      : { nativeTranscripts: value.nativeTranscripts }),
  };
}

async function resolvedRuntimeEnvironment(value: RuntimeConfiguration) {
  const { inherit, set } = configurationEnvironment(value);
  const environment = snapshotEnvironment(inherit, set);
  for (const [name, value] of Object.entries(environment)) {
    if (name === "PATH" && inherit.includes(name) && !Object.hasOwn(set, name))
      environment[name] = await runtimeInheritedPath(value);
  }
  return environment;
}

function configurationEnvironment(value: RuntimeConfiguration) {
  const environment = value.environment;
  return { inherit: environment?.inherit ?? [], set: environment?.set ?? {} };
}

function artifactConfiguration(runtime: RuntimeConfiguration["runtime"]) {
  const directories = runtime?.artifactDirectories;
  if (directories === undefined) return {};
  requireArtifactDirectories(directories);
  return { artifactDirectories: directories };
}
function configurationReadRoots(value: RuntimeConfiguration): string[] {
  return value.filesystem?.readOnlyRoots ?? [];
}
function configurationSeeds(value: RuntimeConfiguration) {
  return value.runtime?.seedDirectories ?? [];
}

function resolvedHooks(hooks: RuntimeConfiguration["hooks"]) {
  return {
    nativeGoal: hooks?.nativeGoal ?? false,
    plugins: hooks?.plugins ?? [],
  };
}

function requireRuntimeSeedRoles(roles: RuntimeRole[] | undefined): void {
  if (roles === undefined) return;
  const allowed = ["candidate", "checks", "hooks", "semantic", "advisory"];
  if (
    !validRoleArray(roles) ||
    new Set(roles).size !== roles.length ||
    roles.some((role) => !allowed.includes(role))
  )
    throw new Error("runtime seed roles are invalid");
}

export function runtimeRoleSeeds(policy: RuntimePolicy, role: RuntimeRole) {
  return (policy.seeds ?? []).filter(
    (seed) => seed.roles === undefined || seed.roles.includes(role),
  );
}

function validRoleArray(roles: unknown): roles is RuntimeRole[] {
  return Array.isArray(roles) && roles.length > 0;
}

export function runtimeSeedSources(
  policy: RuntimePolicy | undefined,
): string[] {
  return [
    ...(policy?.seedReadDenyRoots ?? []),
    ...(policy?.seeds ?? []).map((seed) => seed.source),
  ];
}
