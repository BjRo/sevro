import { isAbsolute } from "node:path";
import { CLAUDE_AUTH_VARIABLES } from "./claude-credential";
import type { RuntimePolicy } from "../runtime-config";
import { runtimeHooksEnabled } from "../runtime-hooks";
import { requireRuntimeReadRoots, isRuntimeHomeRoot } from "../runtime-paths";

function absoluteRule(root: string, tool: "Read" | "Edit"): string {
  if (!isAbsolute(root) || /[\r\n()]/.test(root))
    throw new Error("Claude protected path is invalid");
  return `${tool}(/${root}/**)`;
}

function validPrivatePaths(
  privateRoot: string,
  credentialFile: string,
  roots: string[],
): boolean {
  return !(
    !isAbsolute(privateRoot) ||
    !isAbsolute(credentialFile) ||
    !credentialFile.startsWith(`${privateRoot}/`) ||
    roots.some((root) => !isAbsolute(root) || /[\r\n()]/.test(root))
  );
}

/** Keep agent tools away from the CLI's private state while core auth works. */
export function claudeHostSettings(
  privateRoot: string,
  credentialFile: string,
  pluginRoots: string[] = [],
  protectedRoots: string[] = [],
  runtimePolicy?: RuntimePolicy,
  transcriptReadRoots: string[] = [],
): Record<string, unknown> {
  if (
    !validPrivatePaths(privateRoot, credentialFile, [
      ...pluginRoots,
      ...protectedRoots,
    ])
  )
    throw new Error("Claude private state paths are invalid");
  const readRoots = runtimeReadRoots(runtimePolicy);
  requireRuntimeReadRoots(readRoots, [privateRoot, ...protectedRoots]);
  return {
    disableAllHooks: !runtimeHooksEnabled(runtimePolicy),
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        denyRead: [privateRoot, ...protectedRoots],
        allowRead: [...readRoots, ...transcriptReadRoots, ...pluginRoots],
        denyWrite: [
          privateRoot,
          ...pluginRoots,
          ...protectedRoots,
          ...readRoots,
          ...transcriptReadRoots,
        ],
      },
      credentials: {
        files: [{ path: credentialFile, mode: "deny" }],
        envVars: CLAUDE_AUTH_VARIABLES.map((name) => ({ name, mode: "deny" })),
      },
    },
    permissions: claudePermissions(
      privateRoot,
      protectedRoots,
      pluginRoots,
      runtimePolicy,
      transcriptReadRoots,
    ),
  };
}

function claudePermissions(
  privateRoot: string,
  protectedRoots: string[],
  pluginRoots: string[],
  policy: RuntimePolicy | undefined,
  transcriptReadRoots: string[],
) {
  const roots = [privateRoot, ...protectedRoots];
  const readRoots = policy
    ? roots.filter((root) => !isRuntimeHomeRoot(root))
    : roots;
  const toolRoots = [...runtimeReadRoots(policy), ...transcriptReadRoots];
  return {
    allow: policy
      ? ["Bash", "Edit", "Skill", "Agent"]
      : ["Bash", "Read", "Edit", "Skill", "Agent"],
    ...(policy
      ? {
          blockReadsOutsideWorkingDirectories: true,
          additionalDirectories: [...pluginRoots, ...toolRoots],
        }
      : {}),
    deny: [
      ...roots.flatMap((root) =>
        protectedToolRules(
          root,
          readRoots.includes(root) &&
            ![...transcriptReadRoots, ...pluginRoots].some((path) =>
              path.startsWith(`${root}/`),
            ),
        ),
      ),
      ...[...pluginRoots, ...toolRoots].map((root) =>
        absoluteRule(root, "Edit"),
      ),
    ],
  };
}

function protectedToolRules(root: string, denyRead: boolean): string[] {
  return [
    ...(denyRead ? [absoluteRule(root, "Read")] : []),
    absoluteRule(root, "Edit"),
  ];
}

function runtimeReadRoots(policy: RuntimePolicy | undefined): string[] {
  return policy?.readOnlyRoots ?? [];
}
