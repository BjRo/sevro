import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { requireRuntimeReadRoots } from "../runtime-paths";
import {
  commandRuntimeRoot,
  HostIsolationError,
  requireDisjointState,
  requireIsolationPaths,
  type IsolatedCommand,
  prepareMacSandboxCommand,
} from "./mac-sandbox";

const BWRAP = "/usr/bin/bwrap";
type Options = Parameters<typeof prepareMacSandboxCommand>[0];

async function protectedKind(path: string): Promise<"file" | "directory"> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "directory";
    throw error;
  }
}

function requireLinuxSandbox(): void {
  if (process.platform !== "linux" || !existsSync(BWRAP))
    throw new HostIsolationError("Linux bubblewrap isolation is unavailable");
}

function networkArgs(denyNetwork: boolean): string[] {
  return denyNetwork ? ["--unshare-net"] : [];
}

function mountProtectedRoot(
  path: string,
  kind: "file" | "directory" | undefined,
  blockedFile: string,
): string[] {
  return kind === "directory"
    ? ["--tmpfs", path, "--chmod", "0111", path]
    : ["--ro-bind", blockedFile, path];
}

/** Mask protected inputs before launching an evaluator-owned command. */
export async function prepareLinuxSandboxCommand(
  options: Options,
): Promise<IsolatedCommand> {
  requireLinuxSandbox();
  requireIsolationPaths(options);
  const workspace = await realpath(options.workspace);
  const roots = options.protectedRootsCanonical
    ? options.protectedRoots
    : await Promise.all(options.protectedRoots.map((path) => realpath(path)));
  await mkdir(options.privateStateRoot, { recursive: true, mode: 0o700 });
  const stateRoot = await realpath(options.privateStateRoot);
  const ownedRoot = await commandRuntimeRoot(
    stateRoot,
    options.writableRuntimeRoot,
  );
  const readRoots = options.readOnlyRoots ?? [];
  requireRuntimeReadRoots(readRoots, [...roots, stateRoot]);
  requireDisjointState(workspace, roots, stateRoot);
  const blockedFile = resolve(stateRoot, `blocked-${randomUUID()}`);
  await writeFile(blockedFile, "", { flag: "wx", mode: 0o000 });
  try {
    const protectedRoots = [...new Set([...roots, stateRoot])].sort(
      (left, right) => left.length - right.length,
    );
    const kinds = await Promise.all(protectedRoots.map(protectedKind));
    const masks = protectedRoots.flatMap((path, index) =>
      mountProtectedRoot(path, kinds[index], blockedFile),
    );
    return {
      argv: [
        BWRAP,
        "--die-with-parent",
        "--unshare-user",
        "--unshare-pid",
        ...networkArgs(Boolean(options.denyNetwork)),
        "--ro-bind",
        "/",
        "/",
        "--dev-bind",
        "/dev",
        "/dev",
        "--proc",
        "/proc",
        "--bind",
        "/tmp",
        "/tmp",
        "--bind",
        workspace,
        workspace,
        ...masks,
        ...readRoots.flatMap((path) => ["--ro-bind", path, path]),
        ...(ownedRoot ? ["--bind", ownedRoot, ownedRoot] : []),
        "--chdir",
        workspace,
        "--",
        ...options.argv,
      ],
      release: async () => {
        await rm(blockedFile, { force: true });
      },
    };
  } catch (error) {
    await rm(blockedFile, { force: true });
    throw error;
  }
}
