import { join, sep } from "node:path";
import { minimalRoots as minimalProtectedRoots } from "../platform/index";
import { containsControl } from "../kernel/index";
import {
  insideRuntimeRoot,
  isRuntimeHomeRoot,
  nativeStatePath,
  nativeStateProtectedRoots,
} from "../runtime/index";
import type { IsolationPolicy, IsolationNetwork } from "../isolation/index";
import { workspaceBoundaryException } from "../workspace/index";

const LINUX_MINIMAL_READ_ROOTS = [
  "/bin",
  "/sbin",
  "/usr",
  "/etc",
  "/lib",
  "/lib64",
  "/nix/store",
  "/run/current-system/sw",
];

function toml(value: string): string {
  if (containsControl(value))
    throw new Error("Codex profile value contains a control character");
  return JSON.stringify(value);
}

/** Runner-owned Codex command policy; the Codex parent keeps access to auth. */
export function codexPermissionProfile(options: {
  id: string;
  policy: IsolationPolicy;
  commandEnvironment?: Record<string, string>;
}): string {
  if (!/^[a-z][a-z0-9_]*$/.test(options.id))
    throw new Error("invalid Codex permission profile ID");
  const policy = options.policy;
  const { home, temp } = commandDirectories(policy);
  const name = options.id;
  return [
    `default_permissions = ${toml(name)}`,
    'approval_policy = "never"',
    "allow_login_shell = false",
    ...codexFeatureLines(policy.network === "local-http"),
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    "ignore_default_excludes = false",
    "",
    "[shell_environment_policy.set]",
    ...commandEnvironmentLines(
      options.commandEnvironment,
      policy.read.executables,
    ),
    `HOME = ${toml(home)}`,
    `TMPDIR = ${toml(temp)}`,
    `TMPPREFIX = ${toml(join(temp, sep))}`,
    "",
    `[permissions.${name}]`,
    'extends = ":workspace"',
    "",
    `[permissions.${name}.filesystem]`,
    '":root" = "deny"',
    '":minimal" = "read"',
    ...(process.platform === "linux"
      ? []
      : ['":tmpdir" = "deny"', '":slash_tmp" = "deny"']),
    ...minimalProtectedRoots(profileProtectedRoots(policy))
      .sort()
      .map((root) => `${toml(root)} = "deny"`),
    ...readRootLines(policy),
    ...[...policy.write.native, ...policy.write.caches].map(
      (root) => `${toml(root)} = "write"`,
    ),
    `${toml(home)} = "write"`,
    `${toml(temp)} = "write"`,
    ...optionalRootLines(policy.write.runtime, "write"),
    // Override Codex's metadata carveout only for this isolated fixture.
    `${toml(join(policy.workspace, ".git"))} = "write"`,
    "",
    `[permissions.${name}.filesystem.":workspace_roots"]`,
    '"." = "write"',
    "",
    `[permissions.${name}.network]`,
    ...networkProfile(policy.network),
    "",
  ].join("\n");
}

function codexFeatureLines(localHttp: boolean | undefined): string[] {
  return [
    "[features]",
    "hooks = false",
    ...(localHttp ? ["network_proxy = true"] : []),
  ];
}

function networkProfile(network: IsolationNetwork): string[] {
  if (network === "deny") return ["enabled = false"];
  if (network === "allowed") return ["enabled = true"];
  return [
    "enabled = true",
    "allow_local_binding = true",
    "allow_upstream_proxy = false",
    'domains = { "localhost" = "allow", "127.0.0.1" = "allow", "::1" = "allow" }',
  ];
}

function profileProtectedRoots(options: IsolationPolicy): string[] {
  const readRoots = profileReadRoots(options);
  const trustedRoots = [
    ...readRoots,
    ...options.write.native,
    ...options.write.caches,
    ...(options.write.runtime ? [options.write.runtime] : []),
  ];
  const baselines = [
    ...LINUX_MINIMAL_READ_ROOTS,
    ...readRoots,
    ...options.write.native,
    ...options.write.caches,
    options.workspace,
    options.write.home ?? "",
    options.write.temp ?? "",
    ...(options.write.runtime ? [options.write.runtime] : []),
  ];
  return options.deny.filter(
    (root) =>
      (!implicitLinuxHomeBoundary(root, readRoots, baselines) ||
        process.platform !== "linux") &&
      !implicitNativeBoundary(root, trustedRoots, baselines) &&
      !implicitWorkspaceBoundary(root, options.workspace, baselines),
  );
}

function implicitWorkspaceBoundary(
  root: string,
  workspace: string,
  baselines: string[],
): boolean {
  return (
    process.platform === "linux" &&
    workspaceBoundaryException(root, workspace).length > 0 &&
    !hasBroaderBaseline(root, root, baselines)
  );
}

function implicitNativeBoundary(
  root: string,
  trustedRoots: string[],
  baselines: string[],
): boolean {
  const canonicalRoot = nativeStatePath();
  if (!supportedNativeNamespace(canonicalRoot)) return false;
  const boundary = nativeBoundaryRoot(root, canonicalRoot);
  if (!boundary) return false;
  const descendant = trustedRoots.some((read) =>
    insideRuntimeRoot(boundary, read),
  );
  return descendant && !hasBroaderBaseline(root, boundary, baselines);
}

function nativeBoundaryRoot(
  root: string,
  canonicalRoot: string,
): string | null {
  if (nativeStateProtectedRoots().includes(root)) return canonicalRoot;
  return insideRuntimeRoot(canonicalRoot, root) ? root : null;
}

function hasBroaderBaseline(
  root: string,
  boundary: string,
  baselines: string[],
): boolean {
  return baselines.some(
    (baseline) =>
      insideRuntimeRoot(baseline, boundary) ||
      insideRuntimeRoot(baseline, root),
  );
}

function supportedNativeNamespace(root: string): boolean {
  if (process.platform === "linux")
    return [
      "/var/tmp/sevro-native-private",
      "/private/var/tmp/sevro-native-private",
    ].includes(root);
  return (
    process.platform === "darwin" &&
    /^\/private\/var\/folders\/[^/]+\/[^/]+\/T\/sevro-native-private$/.test(
      root,
    )
  );
}

/** Codex masks deny ancestors after read mounts; the empty-root policy already hides safe HOME ancestors. */
function implicitLinuxHomeBoundary(
  root: string,
  readRoots: string[],
  baselines: string[],
): boolean {
  if (!isRuntimeHomeRoot(root)) return false;
  const descendant = readRoots.some((read) => insideRuntimeRoot(root, read));
  return (
    descendant &&
    !baselines.some((baseline) => insideRuntimeRoot(baseline, root))
  );
}

function commandEnvironmentLines(
  environment: Record<string, string> = {},
  executableReadRoots: string[],
): string[] {
  const systemPath =
    environment.PATH ??
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const path =
    process.platform === "linux"
      ? [...executableReadRoots, systemPath].join(":")
      : systemPath;
  return [
    `PATH = ${toml(path)}`,
    ...Object.entries(environment)
      .filter(([name]) => !["PATH", "HOME", "TMPDIR"].includes(name))
      .map(([name, value]) => `${toml(name)} = ${toml(value)}`),
  ];
}

function optionalRootLines(
  root: string | undefined,
  permission: string,
): string[] {
  return root ? [`${toml(root)} = ${toml(permission)}`] : [];
}

function readRootLines(options: IsolationPolicy): string[] {
  return profileReadRoots(options)
    .sort()
    .map((path) => `${toml(path)} = "read"`);
}

function profileReadRoots(options: IsolationPolicy): string[] {
  const roots = [
    ...options.read.executables,
    ...options.read.runtime,
    ...options.read.native,
    ...options.read.transcripts,
    ...options.read.artifacts,
    ...options.read.hooks,
  ];
  roots.push(...options.read.plugins);
  return [...new Set(roots)];
}

function commandDirectories(policy: IsolationPolicy): {
  home: string;
  temp: string;
} {
  const { home, temp } = policy.write;
  if (!home || !temp) throw new Error("Codex command directories are missing");
  return { home, temp };
}
