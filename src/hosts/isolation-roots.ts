import { readdir, realpath } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { protectedWorktrees } from "./protected-worktrees";

/** Include source, results, host configuration, and every active peer fixture. */
export async function evaluationProtectedRoots(options: {
  workspace: string;
  projectRoot: string;
  resultsRoot: string;
  additionalRoots: string[];
}): Promise<string[]> {
  const workspace = await realpath(options.workspace);
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
  const roots: string[] = [];
  for (const candidate of [...candidates, ...peers]) {
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (
        (peers.includes(candidate) ||
          optionalConfigRoots.includes(candidate)) &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        continue;
      throw new Error("evaluation protected root is unreadable");
    }
    if (canonical !== workspace) {
      roots.push(canonical);
      roots.push(
        ...(await protectedWorktrees(canonical)).filter(
          (root) => root !== workspace,
        ),
      );
    }
  }
  return [...new Set(roots)];
}
