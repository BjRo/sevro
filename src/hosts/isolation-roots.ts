import { isMissingFile } from "../fixture-tools";
import { readdir, realpath } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { protectedWorktrees } from "./protected-worktrees";

/** Include source, results, host configuration, and every active peer fixture. */
interface ProtectedRootsOptions {
  workspace: string;
  projectRoot: string;
  resultsRoot: string;
  additionalRoots: string[];
}

async function protectedRootCandidates(options: ProtectedRootsOptions) {
  const optionalConfigRoots = [
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
  ].filter((value): value is string => Boolean(value));
  const candidates = [
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
  const peers = (await readdir(tmpdir(), { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("sevro-case-"),
    )
    .map((entry) => join(tmpdir(), entry.name));
  return { candidates, peers, optionalConfigRoots };
}

/** Include source, results, host configuration, and every active peer fixture. */
export async function evaluationProtectedRoots(
  options: ProtectedRootsOptions,
): Promise<string[]> {
  const workspace = await realpath(options.workspace);
  const { candidates, peers, optionalConfigRoots } =
    await protectedRootCandidates(options);
  const roots: string[] = [];
  for (const candidate of [...candidates, ...peers]) {
    const canonical = await canonicalProtectedRoot(candidate, [
      ...peers,
      ...optionalConfigRoots,
    ]);
    if (canonical === null || canonical === workspace) continue;
    {
      roots.push(canonical);
      // Peers are denied directly; their Git preparation may still be in progress.
      if (!peers.includes(candidate))
        roots.push(
          ...(await protectedWorktrees(canonical)).filter(
            (root) => root !== workspace,
          ),
        );
    }
  }
  return [...new Set(roots)];
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
