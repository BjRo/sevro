import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ErrorObject } from "ajv";
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
  resolveSharedCaches,
  requireSharedCachePolicy,
  type SharedCacheDirectory,
} from "./shared-cache";
import {
  discoverRuntimeSupport,
  type RuntimeDiscoverySource,
} from "./discovery";

/** Canonical roles; schemas:generate projects this list into the runtime schema. */
export const RUNTIME_ROLES = [
  "candidate",
  "checks",
  "hooks",
  "semantic",
  "advisory",
] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];
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
    sharedCacheDirectories?: SharedCacheDirectory[];
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
  sharedCacheDirectories?: SharedCacheDirectory[];
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

const validatedPolicies = new WeakSet<RuntimePolicy>();

export function runtimePolicySnapshot(policy: RuntimePolicy): RuntimePolicy;
export function runtimePolicySnapshot(
  policy: RuntimePolicy | undefined,
): RuntimePolicy | undefined;
export function runtimePolicySnapshot(
  policy: RuntimePolicy | undefined,
): RuntimePolicy | undefined {
  if (!policy) return undefined;
  const snapshot = structuredClone(policy);
  if (!validatedPolicies.has(policy)) requireRuntimePolicy(snapshot);
  Object.freeze(snapshot.network);
  freezeArtifactDirectories(snapshot);
  Object.freeze(snapshot.environment);
  Object.freeze(snapshot.readOnlyRoots);
  freezeDiscovery(snapshot);
  freezeRuntimeCaches(snapshot);
  Object.freeze(snapshot.seedReadDenyRoots);
  const hooks = snapshot.hooks;
  if (hooks) {
    Object.freeze(hooks.plugins);
    Object.freeze(hooks);
  }
  Object.freeze(snapshot);
  validatedPolicies.add(snapshot);
  return snapshot;
}

/** Loaded snapshots are already validated; mutable direct API inputs still need validation. */
export function requireRuntimePolicy(policy: RuntimePolicy): void {
  if (validatedPolicies.has(policy)) return;
  snapshotEnvironment([], policy.environment);
  requireRuntimeCaches(policy.seeds ?? [], policy.sharedCacheDirectories ?? []);
  requireSharedCachePolicy(policy);
  requireArtifactDirectories(policy.artifactDirectories ?? []);
}

function requireRuntimeCaches(
  seeds: RuntimeSeed[],
  caches: SharedCacheDirectory[],
): void {
  requireRuntimeSeedTargets([...seeds, ...caches]);
  for (const seed of seeds)
    if (seed.roles !== undefined) requireRuntimeRoles(seed.roles, "seed");
  for (const cache of caches) requireRuntimeRoles(cache.roles, "shared cache");
}

function freezeRuntimeCaches(snapshot: RuntimePolicy): void {
  for (const seed of [
    ...(snapshot.seeds ?? []),
    ...(snapshot.sharedCacheDirectories ?? []),
  ]) {
    Object.freeze(seed.roles);
    Object.freeze(seed);
  }
  Object.freeze(snapshot.seeds);
  Object.freeze(snapshot.sharedCacheDirectories);
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
  for (const directory of directories) Object.freeze(directory);
  Object.freeze(snapshot.artifactDirectories);
}

function assertRuntimeConfiguration(
  value: unknown,
): asserts value is RuntimeConfiguration {
  if (!validate(value)) {
    // Ajv always populates errors when validation fails.
    const issue = (validate.errors as [ErrorObject, ...ErrorObject[]])[0];
    throw new Error(
      `runtime configuration schema ${runtimeSchemaPath(issue)}: ${issue.message}`,
    );
  }
}

function runtimeSchemaPath(issue: ErrorObject): string {
  const params = issue.params as Record<string, unknown>;
  const property = params.additionalProperty ?? params.missingProperty;
  const suffix =
    typeof property === "string"
      ? "/" + property.replaceAll("~", "~0").replaceAll("/", "~1")
      : "";
  return safeFilesystemPath(issue.instancePath + suffix || "/");
}

const RESERVED_ENVIRONMENT =
  /^(HOME|TMPDIR|TMPPREFIX|TMP|TEMP|CODEX_HOME|CODEX_THREAD_ID|CLAUDE_CONFIG_DIR|CLAUDE_EFFORT|BASH_ENV|ENV|ZDOTDIR|NODE_OPTIONS|BUN_OPTIONS|UV_OFFLINE|GIT_CONFIG.*|LD_.*|DYLD_.*|CLAUDE_CODE_.*|SEVRO_CODEX_.*|SEVRO_NATIVE_.*|SEVRO_CANDIDATE_.*)$/i;

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

function requireRuntimeSeedTargets(seeds: RuntimeSeed[]): void {
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
    return runtimePolicySnapshot(
      await resolveRuntimeConfiguration(
        parseRuntimeConfiguration(source),
        dirname(canonical),
        protectedRoots,
      ),
    );
  } catch (cause) {
    throw new Error(
      `${runtimeConfigurationDiagnostic(cause)} at ${safeFilesystemPath(path)}`,
      { cause },
    );
  }
}

function parseRuntimeConfiguration(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new Error(
      "runtime configuration $: invalid JSON; check the JSON syntax",
      { cause },
    );
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
  return Promise.all(
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
    ...(await resolvedRuntimeCaches(value, environment, base, [
      ...protectedRoots,
      ...readOnlyRoots,
    ])),
    hooks: resolvedHooks(value.hooks),
  };
}

async function resolvedRuntimeCaches(
  value: RuntimeConfiguration,
  environment: Record<string, string>,
  base: string,
  protectedRoots: string[],
) {
  const seeds = await resolvedSeeds(
    configurationSeeds(value),
    environment,
    base,
  );
  const caches = await resolveSharedCaches(
    value.runtime?.sharedCacheDirectories ?? [],
    environment,
    base,
    [...protectedRoots, ...seeds.map((seed) => seed.source)],
  );
  return {
    seeds,
    ...(caches.length ? { sharedCacheDirectories: caches } : {}),
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

function requireRuntimeRoles(roles: RuntimeRole[], kind: string): void {
  if (
    !validRoleArray(roles) ||
    new Set(roles).size !== roles.length ||
    roles.some((role) => !RUNTIME_ROLES.includes(role))
  )
    throw new Error(`runtime ${kind} roles are invalid`);
}

export function runtimeRoleSeeds(policy: RuntimePolicy, role: RuntimeRole) {
  return (policy.seeds ?? []).filter(
    (seed) => seed.roles?.includes(role) ?? role !== "checks",
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
