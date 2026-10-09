import { isAbsolute, sep } from "node:path";
import { insideRuntimeRoot, isRuntimeHomeRoot } from "../runtime-paths";
import { nativeStatePath } from "../native-transcript-state";

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
  if (
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  )
    throw new Error("Codex profile value contains a control character");
  return JSON.stringify(value);
}

/** Runner-owned Codex command policy; the Codex parent keeps access to auth. */
export function codexPermissionProfile(options: {
  id: string;
  workspace: string;
  commandHome: string;
  commandTemp: string;
  executableReadRoots: string[];
  pluginReadRoot?: string;
  protectedRoots: string[];
  commandEnvironment?: Record<string, string>;
  runtimeReadRoots?: string[];
  nativeReadRoots?: string[];
  runtimeWriteRoot?: string;
}): string {
  if (!/^[a-z][a-z0-9_]*$/.test(options.id))
    throw new Error("invalid Codex permission profile ID");
  if (!validProfilePaths(options))
    throw new Error("Codex profile paths must be absolute and protected");
  const name = options.id;
  return [
    `default_permissions = ${toml(name)}`,
    'approval_policy = "never"',
    "allow_login_shell = false",
    "[features]",
    "hooks = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    "ignore_default_excludes = false",
    "",
    "[shell_environment_policy.set]",
    ...commandEnvironmentLines(
      options.commandEnvironment,
      options.executableReadRoots,
    ),
    `HOME = ${toml(options.commandHome)}`,
    `TMPDIR = ${toml(options.commandTemp)}`,
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
    ...minimalProtectedRoots(profileProtectedRoots(options))
      .sort()
      .map((root) => `${toml(root)} = "deny"`),
    ...readRootLines(options),
    `${toml(options.commandHome)} = "write"`,
    `${toml(options.commandTemp)} = "write"`,
    ...optionalRootLines(options.runtimeWriteRoot, "write"),
    "",
    `[permissions.${name}.filesystem.":workspace_roots"]`,
    '"." = "write"',
    "",
    `[permissions.${name}.network]`,
    "enabled = false",
    "",
  ].join("\n");
}

function profileProtectedRoots(
  options: Parameters<typeof codexPermissionProfile>[0],
): string[] {
  const readRoots = profileReadRoots(options);
  const baselines = [
    ...LINUX_MINIMAL_READ_ROOTS,
    ...readRoots,
    options.workspace,
    options.commandHome,
    options.commandTemp,
    ...(options.runtimeWriteRoot ? [options.runtimeWriteRoot] : []),
  ];
  return options.protectedRoots.filter(
    (root) =>
      (!implicitLinuxHomeBoundary(root, readRoots, baselines) &&
        !implicitLinuxNativeBoundary(
          root,
          options.nativeReadRoots ?? [],
          baselines,
        )) ||
      process.platform !== "linux",
  );
}

function implicitLinuxNativeBoundary(
  root: string,
  trustedReadRoots: string[],
  baselines: string[],
): boolean {
  if (root !== nativeStatePath()) return false;
  const descendant = trustedReadRoots.some(
    (read) => read !== root && insideRuntimeRoot(root, read),
  );
  return (
    descendant &&
    !baselines.some((baseline) => insideRuntimeRoot(baseline, root))
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

function minimalProtectedRoots(roots: string[]): string[] {
  return [...new Set(roots)].filter(
    (root) =>
      !roots.some(
        (other) => other !== root && root.startsWith(`${other}${sep}`),
      ),
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

function readRootLines(
  options: Parameters<typeof codexPermissionProfile>[0],
): string[] {
  return profileReadRoots(options)
    .sort()
    .map((path) => `${toml(path)} = "read"`);
}

function profileReadRoots(
  options: Parameters<typeof codexPermissionProfile>[0],
): string[] {
  const roots = [
    ...options.executableReadRoots,
    ...(options.runtimeReadRoots ?? []),
    ...(options.nativeReadRoots ?? []),
  ];
  if (options.pluginReadRoot) roots.push(options.pluginReadRoot);
  return [...new Set(roots)];
}

function readRoot(path: string): boolean {
  return isAbsolute(path) && path !== "/";
}

function optionalReadRoot(path: string | undefined): boolean {
  return path === undefined || readRoot(path);
}

function validProfilePaths(
  options: Parameters<typeof codexPermissionProfile>[0],
): boolean {
  const privatePaths = [
    options.workspace,
    options.commandHome,
    options.commandTemp,
  ];
  return (
    privatePaths.every(isAbsolute) &&
    validExecutableRoots(options.executableReadRoots) &&
    optionalReadRoot(options.pluginReadRoot) &&
    validProtectedRoots(options.protectedRoots)
  );
}

function validExecutableRoots(paths: string[]): boolean {
  return paths.length > 0 && paths.every(readRoot);
}

function validProtectedRoots(paths: string[]): boolean {
  return paths.length > 0 && paths.every(isAbsolute);
}
