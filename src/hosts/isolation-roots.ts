import { isMissingFile } from "../fixture-tools";
import { realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { protectedWorktrees } from "./protected-worktrees";
import { nativeStateParent } from "../native-transcript-state";
import { workspaceStateParent } from "../workspace-state";

/** Include source, results, host configuration, and every active peer fixture. */
interface ProtectedRootsOptions {
  workspace: string;
  projectRoot: string;
  resultsRoot: string;
  additionalRoots: string[];
  ownedStateRoot?: string;
}

async function protectedRootCandidates(options: ProtectedRootsOptions) {
  const optionalConfigRoots = [
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
  ].filter((value): value is string => Boolean(value));
  const candidates = [
    await nativeStateParent(),
    await workspaceStateParent(),
    resolve(import.meta.dir, "../.."),
    options.projectRoot,
    options.resultsRoot,
    homedir(),
    userInfo().homedir,
    ...options.additionalRoots,
    ...optionalConfigRoots,
  ];
  if (candidates.some((root) => !isAbsolute(root)))
    throw new Error("evaluation protected roots must be absolute");
  return { candidates, optionalConfigRoots };
}

/** Include source, results, host configuration, and every active peer fixture. */
export async function evaluationProtectedRoots(
  options: ProtectedRootsOptions,
): Promise<string[]> {
  const workspace = await realpath(options.workspace);
  const { candidates, optionalConfigRoots } =
    await protectedRootCandidates(options);
  const namespace = await workspaceStateParent();
  const nativeNamespace = await nativeStateParent();
  const roots: string[] = [];
  for (const candidate of candidates) {
    const canonical = await canonicalProtectedRoot(candidate, [
      ...optionalConfigRoots,
    ]);
    if (!includedProtectedRoot(canonical, workspace, options.ownedStateRoot))
      continue;
    {
      roots.push(canonical);
      // Private namespaces are boundaries, not Git source trees to traverse.
      if (canonical !== namespace && canonical !== nativeNamespace)
        roots.push(
          ...(await protectedWorktrees(canonical)).filter(
            (root) => root !== workspace,
          ),
        );
    }
  }
  return [...new Set(roots)];
}

function includedProtectedRoot(
  root: string | null,
  workspace: string,
  state: string | undefined,
): root is string {
  return root !== null && root !== workspace && root !== state;
}

async function canonicalProtectedRoot(
  candidate: string,
  optionalRoots: string[],
): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch (cause) {
    if (optionalRoots.includes(candidate) && isMissingFile(cause)) return null;
    throw new Error("evaluation protected root is unreadable", { cause });
  }
}
