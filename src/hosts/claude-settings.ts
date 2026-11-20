import { isAbsolute } from "node:path";
import { CLAUDE_AUTH_VARIABLES } from "../claude-login/index";
import {
  requireRuntimeReadRoots,
  isRuntimeHomeRoot,
  type RuntimePolicy,
  nativeStatePath,
} from "../runtime/index";
import { runtimeHooksEnabled } from "../hooks/index";
import {
  workspaceStatePath,
  workspaceBoundaryException,
} from "../workspace/index";

interface WritableRuntime {
  root: string;
  workspace: string;
  cacheRoots: string[];
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
  pluginRoots: string[],
  protectedRoots: string[],
  runtimePolicy: RuntimePolicy | undefined,
  transcriptReadRoots: string[],
  runtime: WritableRuntime | undefined,
  workspace: string | undefined,
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
  requireRuntimeReadRoots(runtimeCacheRoots(runtime), [
    privateRoot,
    ...protectedRoots,
  ]);
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
        workspace,
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
      workspace,
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
  workspace: string | undefined,
) {
  const runtimeWriteRoot = runtime?.root;
  const writableRoots = runtimeWriteRoots(runtime);
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
        runtimeCacheRoots(runtime),
      ),
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
  workspace: string | undefined,
) {
  const runtimeWriteRoot = runtime?.root;
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
  const readRoots = policy
    ? roots.filter((root) => !isRuntimeHomeRoot(root))
    : roots;
  const toolRoots = [...runtimeReadRoots(policy), ...transcriptReadRoots];
  const writableRoots = runtimeWriteRoots(runtime);
  return {
    allow: claudeToolAllowRules(runtime, managedWorkspace),
    ...(policy || managedWorkspace
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
        runtimeCacheRoots(runtime),
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
  runtime: WritableRuntime | undefined,
  workspace?: string,
): string[] {
  if (!runtime)
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
    absoluteRule(runtime.workspace, "Edit"),
    absoluteRule(runtime.root, "Edit"),
    ...runtime.cacheRoots.map((root) => absoluteRule(root, "Edit")),
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

function runtimeCacheRoots(runtime: WritableRuntime | undefined): string[] {
  return runtime?.cacheRoots ?? [];
}

function runtimeWriteRoots(runtime: WritableRuntime | undefined): string[] {
  return [
    ...optionalRuntimeRoot(runtime?.root),
    ...(runtime?.cacheRoots ?? []),
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

function runtimeReadRoots(policy: RuntimePolicy | undefined): string[] {
  return policy?.readOnlyRoots ?? [];
}
