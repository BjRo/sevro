import { isAbsolute } from "node:path";

function absoluteRule(root: string, tool: "Read" | "Edit"): string {
  if (!isAbsolute(root) || /[\r\n()]/.test(root))
    throw new Error("Claude protected path is invalid");
  return `${tool}(/${root}/**)`;
}

/** Keep agent tools away from the CLI's private state while core auth works. */
export function claudeHostSettings(
  privateRoot: string,
  credentialFile: string,
  pluginRoots: string[] = [],
  protectedRoots: string[] = [],
): Record<string, unknown> {
  if (
    !isAbsolute(privateRoot) ||
    !isAbsolute(credentialFile) ||
    !credentialFile.startsWith(`${privateRoot}/`) ||
    [...pluginRoots, ...protectedRoots].some(
      (root) => !isAbsolute(root) || /[\r\n()]/.test(root),
    )
  )
    throw new Error("Claude private state paths are invalid");
  return {
    disableAllHooks: true,
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        denyRead: [privateRoot, ...protectedRoots],
        denyWrite: [privateRoot, ...pluginRoots, ...protectedRoots],
      },
      credentials: {
        files: [{ path: credentialFile, mode: "deny" }],
      },
    },
    permissions: {
      allow: ["Bash", "Read", "Edit", "Skill", "Agent"],
      deny: [
        ...[privateRoot, ...protectedRoots].flatMap((root) => [
          absoluteRule(root, "Read"),
          absoluteRule(root, "Edit"),
        ]),
        ...pluginRoots.map((root) => absoluteRule(root, "Edit")),
      ],
    },
  };
}
