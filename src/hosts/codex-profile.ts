import { isAbsolute } from "node:path";

function toml(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value))
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
  protectedRoots: string[];
}): string {
  if (!/^[a-z][a-z0-9_]*$/.test(options.id))
    throw new Error("invalid Codex permission profile ID");
  if (
    !isAbsolute(options.workspace) ||
    !isAbsolute(options.commandHome) ||
    !isAbsolute(options.commandTemp) ||
    !options.executableReadRoots.length ||
    options.executableReadRoots.some(
      (path) => !isAbsolute(path) || path === "/",
    ) ||
    !options.protectedRoots.length ||
    options.protectedRoots.some((root) => !isAbsolute(root))
  )
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
    `${toml(options.commandHome)} = "write"`,
    `${toml(options.commandTemp)} = "write"`,
    "",
    `[permissions.${name}.filesystem.\":workspace_roots\"]`,
    '"." = "write"',
    "",
    `[permissions.${name}.network]`,
    "enabled = false",
    "",
  ].join("\n");
}
