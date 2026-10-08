import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { insideRuntimeRoot } from "../runtime-paths";

export class HostIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostIsolationError";
  }
}

export interface IsolationOptions {
  argv: string[];
  workspace: string;
  protectedRoots: string[];
  protectedRootsCanonical?: boolean;
  privateStateRoot: string;
  denyNetwork?: boolean;
  readOnlyRoots?: string[];
  writableRuntimeRoot?: string;
}

export interface IsolatedCommand {
  argv: string[];
  release(): Promise<void>;
}

export function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep))
  );
}

export async function commandRuntimeRoot(
  stateRoot: string,
  path: string | undefined,
): Promise<string | undefined> {
  if (!path) return undefined;
  const root = await realpath(path);
  if (root === stateRoot || !insideRuntimeRoot(stateRoot, root))
    throw new HostIsolationError(
      "command runtime must be contained in private state",
    );
  return root;
}

export function requireIsolationPaths(options: IsolationOptions): void {
  if (!options.argv.length || options.argv.some((part) => !part))
    throw new HostIsolationError("isolated command must be nonempty");
  if (!options.protectedRoots.length)
    throw new HostIsolationError("isolated command needs protected roots");
  if (!absoluteIsolationPaths(options))
    throw new HostIsolationError("isolation paths must be absolute");
}

function absoluteIsolationPaths(options: IsolationOptions): boolean {
  return (
    isAbsolute(options.workspace) &&
    isAbsolute(options.privateStateRoot) &&
    options.protectedRoots.every(isAbsolute)
  );
}

export function requireDisjointState(
  workspace: string,
  roots: string[],
  stateRoot: string,
): void {
  if (
    roots.some((root) => inside(root, workspace)) ||
    inside(stateRoot, workspace)
  )
    throw new HostIsolationError(
      "protected root includes the candidate workspace",
    );
  if (inside(workspace, stateRoot))
    throw new HostIsolationError(
      "sandbox state is inside the candidate workspace",
    );
}
