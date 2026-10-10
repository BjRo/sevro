import { isAbsolute } from "node:path";
import { CLAUDE_AUTH_VARIABLES } from "./claude-credential";
import type { RuntimePolicy } from "../runtime-config";
import { runtimeHooksEnabled } from "../runtime-hooks";
import { requireRuntimeReadRoots, isRuntimeHomeRoot } from "../runtime-paths";
import { nativeStatePath } from "../native-transcript-state";

interface WritableRuntime {
  root: string;
  workspace: string;
}

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
  runtime?: WritableRuntime,
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
      filesystem: claudeFilesystemPolicy(
        privateRoot,
        protectedRoots,
        readRoots,
        transcriptReadRoots,
        pluginRoots,
        runtime,
      ),
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
      runtime,
    ),
  };
}

function claudeFilesystemPolicy(
  privateRoot: string,
  protectedRoots: string[],
  readRoots: string[],
  transcriptReadRoots: string[],
  pluginRoots: string[],
  runtime: WritableRuntime | undefined,
) {
  const runtimeWriteRoot = runtime?.root;
  return {
    denyRead: [privateRoot, ...protectedRoots],
    allowRead: [
      ...readRoots,
      ...transcriptReadRoots,
      ...pluginRoots,
      ...optionalRuntimeRoot(runtimeWriteRoot),
    ],
    ...(runtimeWriteRoot ? { allowWrite: [runtimeWriteRoot] } : {}),
    denyWrite: [
      privateRoot,
      ...pluginRoots,
      ...writableProtectedRoots(protectedRoots, runtimeWriteRoot),
      ...readRoots,
      ...transcriptReadRoots,
    ],
  };
}

function claudePermissions(
  privateRoot: string,
  protectedRoots: string[],
  pluginRoots: string[],
  policy: RuntimePolicy | undefined,
  transcriptReadRoots: string[],
  runtime: WritableRuntime | undefined,
) {
  const runtimeWriteRoot = runtime?.root;
  const roots = [privateRoot, ...protectedRoots];
  const readRoots = policy
    ? roots.filter((root) => !isRuntimeHomeRoot(root))
    : roots;
  const toolRoots = [...runtimeReadRoots(policy), ...transcriptReadRoots];
  const writableRoots = optionalRuntimeRoot(runtimeWriteRoot);
  return {
    allow: claudeToolAllowRules(policy, runtime),
    ...(policy
      ? {
          blockReadsOutsideWorkingDirectories: true,
          additionalDirectories: [
            ...pluginRoots,
            ...toolRoots,
            ...writableRoots,
          ],
        }
      : {}),
    deny: [
      ...writableProtectedRoots(roots, runtimeWriteRoot).flatMap((root) =>
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

function claudeToolAllowRules(
  policy: RuntimePolicy | undefined,
  runtime: WritableRuntime | undefined,
): string[] {
  if (!policy) return ["Bash", "Read", "Edit", "Skill", "Agent"];
  if (!runtime) return ["Bash", "Edit", "Skill", "Agent"];
  return [
    "Bash",
    "Skill",
    "Agent",
    absoluteRule(runtime.workspace, "Edit"),
    absoluteRule(runtime.root, "Edit"),
  ];
}

/** Native write denies override grants; the namespace stays read-denied and has no write grant. */
function writableProtectedRoots(
  roots: string[],
  runtimeWriteRoot: string | undefined,
): string[] {
  if (!runtimeWriteRoot) return roots;
  const namespace = nativeStatePath();
  return roots.filter(
    (root) =>
      root !== namespace || !runtimeWriteRoot.startsWith(`${namespace}/`),
  );
}

function optionalRuntimeRoot(root: string | undefined): string[] {
  return root ? [root] : [];
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
