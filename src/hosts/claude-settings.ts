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
): Record<string, unknown> {
  if (
    !isAbsolute(privateRoot) ||
    !isAbsolute(credentialFile) ||
    !credentialFile.startsWith(`${privateRoot}/`)
  )
    throw new Error("Claude private state paths are invalid");
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        denyRead: [privateRoot],
        denyWrite: [privateRoot],
      },
      credentials: {
        files: [{ path: credentialFile, mode: "deny" }],
      },
    },
    permissions: {
      allow: ["Bash", "Read", "Edit", "Write", "Skill", "Agent"],
      deny: [
        absoluteRule(privateRoot, "Read"),
        absoluteRule(privateRoot, "Edit"),
      ],
    },
  };
}
