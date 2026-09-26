import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export class HostIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostIsolationError";
  }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep))
  );
}

function quoted(path: string): string {
  if (/[\x00-\x1f\x7f]/.test(path))
    throw new HostIsolationError("sandbox path contains a control character");
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Deny both observation and mutation of every protected canonical root. */
export function macSandboxProfile(
  deniedRoots: string[],
  denyNetwork = false,
): string {
  if (!deniedRoots.length || deniedRoots.some((path) => !path.startsWith("/")))
    throw new HostIsolationError("sandbox roots must be absolute and nonempty");
  return [
    "(version 1)",
    "(allow default)",
    ...(denyNetwork ? ["(deny network*)"] : []),
    ...[...new Set(deniedRoots)]
      .sort()
      .flatMap((path) => [
        `(deny file-read* (subpath "${quoted(path)}"))`,
        `(deny file-write* (subpath "${quoted(path)}"))`,
      ]),
    "",
  ].join("\n");
}

export interface IsolatedCommand {
  argv: string[];
  release(): Promise<void>;
}

/** Build the outer boundary before launching an agent or candidate-controlled code. */
export async function prepareMacSandboxCommand(options: {
  argv: string[];
  workspace: string;
  protectedRoots: string[];
  privateStateRoot: string;
  denyNetwork?: boolean;
}): Promise<IsolatedCommand> {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC))
    throw new HostIsolationError("macOS sandbox-exec isolation is unavailable");
  if (!options.argv.length || options.argv.some((part) => !part))
    throw new HostIsolationError("isolated command must be nonempty");
  if (!options.protectedRoots.length)
    throw new HostIsolationError("isolated command needs protected roots");
  if (
    !isAbsolute(options.workspace) ||
    !isAbsolute(options.privateStateRoot) ||
    options.protectedRoots.some((path) => !isAbsolute(path))
  )
    throw new HostIsolationError("isolation paths must be absolute");
  const workspace = await realpath(options.workspace);
  const roots = await Promise.all(
    options.protectedRoots.map((path) => realpath(path)),
  );
  await mkdir(options.privateStateRoot, { recursive: true, mode: 0o700 });
  const stateRoot = await realpath(options.privateStateRoot);
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
  const profilePath = resolve(stateRoot, `host-${randomUUID()}.sb`);
  await writeFile(
    profilePath,
    macSandboxProfile([...roots, stateRoot], options.denyNetwork),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  return {
    argv: [SANDBOX_EXEC, "-f", profilePath, ...options.argv],
    release: async () => {
      await rm(profilePath, { force: true });
    },
  };
}
