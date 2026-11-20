import { isAbsolute } from "node:path";
import { CLAUDE_AUTH_VARIABLES } from "../claude-login/index";
import { isRuntimeHomeRoot, nativeStatePath } from "../runtime/index";
import type { IsolationPolicy } from "../isolation/index";
import {
  workspaceStatePath,
  workspaceBoundaryException,
} from "../workspace/index";

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
  policy: IsolationPolicy,
  credentialFile: string,
): Record<string, unknown> {
  const privateRoot = policy.privateStateRoot;
  if (
    !validPrivatePaths(privateRoot, credentialFile, [
      ...policy.read.plugins,
      ...policy.deny,
    ])
  )
    throw new Error("Claude private state paths are invalid");
  return {
    disableAllHooks: !policy.hooksEnabled,
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: claudeFilesystemPolicy(policy),
      credentials: {
        files: [{ path: credentialFile, mode: "deny" }],
        envVars: CLAUDE_AUTH_VARIABLES.map((name) => ({ name, mode: "deny" })),
      },
    },
    permissions: claudePermissions(policy),
  };
}

function claudeFilesystemPolicy(policy: IsolationPolicy) {
  const privateRoot = policy.privateStateRoot;
  const protectedRoots = policy.deny;
  const readRoots = policy.read.runtime;
  const transcriptReadRoots = curatedRoots(policy);
  const pluginRoots = policy.read.plugins;
  const workspace = policy.workspace;
  const runtimeWriteRoot = policy.write.runtime;
  const writableRoots = runtimeWriteRoots(policy);
  return {
    denyRead: [privateRoot, ...protectedRoots],
    allowRead: [
      ...workspaceBoundaryException(workspaceStatePath(), workspace),
      ...readRoots,
      ...transcriptReadRoots,
      ...pluginRoots,
      ...writableRoots,
    ],
    ...(writableRoots.length ? { allowWrite: writableRoots } : {}),
    denyWrite: [
      privateRoot,
      ...pluginRoots,
      ...writableProtectedRoots(
        protectedRoots,
        runtimeWriteRoot,
        workspace,
        policy.write.caches,
      ),
      ...readRoots,
      ...transcriptReadRoots,
    ],
  };
}

function claudePermissions(policy: IsolationPolicy) {
  const privateRoot = policy.privateStateRoot;
  const protectedRoots = policy.deny;
  const pluginRoots = policy.read.plugins;
  const transcriptReadRoots = curatedRoots(policy);
  const workspace = policy.workspace;
  const runtimeWriteRoot = policy.write.runtime;
  const roots = [
    privateRoot,
    ...protectedRoots.filter(
      (root) => !workspaceBoundaryException(root, workspace).length,
    ),
  ];
  const managedWorkspace = workspaceBoundaryException(
    workspaceStatePath(),
    workspace,
  )[0];
  const readRoots = policy.runtimeDeclared
    ? roots.filter((root) => !isRuntimeHomeRoot(root))
    : roots;
  const toolRoots = [...policy.read.runtime, ...transcriptReadRoots];
  const writableRoots = runtimeWriteRoots(policy);
  return {
    allow: claudeToolAllowRules(policy, managedWorkspace),
    ...(policy.runtimeDeclared || managedWorkspace
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
      ...writableProtectedRoots(
        roots,
        runtimeWriteRoot,
        workspace,
        policy.write.caches,
      ).flatMap((root) =>
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

/** A runtime policy always supplies its writable runtime; legacy runs have none. */
function claudeToolAllowRules(
  policy: IsolationPolicy,
  workspace?: string,
): string[] {
  const root = policy.write.runtime;
  if (!root)
    return [
      "Bash",
      "Read",
      "Skill",
      "Agent",
      "SendMessage",
      workspace ? absoluteRule(workspace, "Edit") : "Edit",
    ];
  return [
    "Bash",
    "Skill",
    "Agent",
    "SendMessage",
    absoluteRule(policy.workspace, "Edit"),
    absoluteRule(root, "Edit"),
    ...policy.write.caches.map((cache) => absoluteRule(cache, "Edit")),
  ];
}

/** Native write denies override grants; the namespace stays read-denied and has no write grant. */
function writableProtectedRoots(
  roots: string[],
  runtimeWriteRoot: string | undefined,
  workspace: string | undefined,
  cacheRoots: string[],
): string[] {
  const namespace = nativeStatePath();
  return roots.filter(
    (root) =>
      !workspaceBoundaryException(root, workspace).length &&
      !sharedHomeGrant(root, cacheRoots) &&
      keepNativeWriteDeny(root, namespace, runtimeWriteRoot),
  );
}

function sharedHomeGrant(root: string, cacheRoots: string[]): boolean {
  return (
    isRuntimeHomeRoot(root) &&
    cacheRoots.some((cache) => cache.startsWith(`${root}/`))
  );
}

function runtimeWriteRoots(policy: IsolationPolicy): string[] {
  return [...optionalRuntimeRoot(policy.write.runtime), ...policy.write.caches];
}

function curatedRoots(policy: IsolationPolicy): string[] {
  return [
    ...policy.read.native,
    ...policy.read.transcripts,
    ...policy.read.artifacts,
    ...policy.read.hooks,
  ];
}

function keepNativeWriteDeny(
  root: string,
  namespace: string,
  runtimeWriteRoot?: string,
): boolean {
  return (
    root !== namespace ||
    runtimeWriteRoot === undefined ||
    !runtimeWriteRoot.startsWith(`${namespace}/`)
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
