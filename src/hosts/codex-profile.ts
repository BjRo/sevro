import { isAbsolute } from "node:path";

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
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    "ignore_default_excludes = false",
    "",
    "[shell_environment_policy.set]",
    'PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
    `HOME = ${toml(options.commandHome)}`,
    `TMPDIR = ${toml(options.commandTemp)}`,
    "",
    `[permissions.${name}]`,
    'extends = ":workspace"',
    "",
    `[permissions.${name}.filesystem]`,
    '":root" = "deny"',
    '":minimal" = "read"',
    '":tmpdir" = "deny"',
    '":slash_tmp" = "deny"',
    ...[...new Set(options.protectedRoots)]
      .sort()
      .map((root) => `${toml(root)} = "deny"`),
    ...[...new Set(options.executableReadRoots)]
      .sort()
      .map((path) => `${toml(path)} = "read"`),
    ...(options.pluginReadRoot
      ? [`${toml(options.pluginReadRoot)} = "read"`]
      : []),
    `${toml(options.commandHome)} = "write"`,
    `${toml(options.commandTemp)} = "write"`,
    "",
    `[permissions.${name}.filesystem.":workspace_roots"]`,
    '"." = "write"',
    "",
    `[permissions.${name}.network]`,
    "enabled = false",
    "",
  ].join("\n");
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
