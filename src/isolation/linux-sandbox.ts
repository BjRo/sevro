import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HostIsolationError, type IsolatedCommand } from "./isolation-common";
import type { IsolationPolicy } from "./policy";

const BWRAP = "/usr/bin/bwrap";

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
  policy: IsolationPolicy,
  argv: string[],
): Promise<IsolatedCommand> {
  requireLinuxSandbox();
  const stateRoot = policy.privateStateRoot;
  const blockedFile = resolve(stateRoot, `blocked-${randomUUID()}`);
  await writeFile(blockedFile, "", { flag: "wx", mode: 0o000 });
  try {
    const protectedRoots = [
      ...new Set([...policy.deny, policy.privateStateRoot]),
    ].sort((left, right) => left.length - right.length);
    const kinds = await Promise.all(protectedRoots.map(protectedKind));
    const masks = protectedRoots.flatMap((path, index) =>
      mountProtectedRoot(path, kinds[index], blockedFile),
    );
    return {
      argv: linuxSandboxArguments(policy, argv, masks),
      release: async () => {
        await rm(blockedFile, { force: true });
      },
    };
  } catch (error) {
    await rm(blockedFile, { force: true });
    throw error;
  }
}

/** A policy renderer over validated grants; masks encode protected file kinds. */
export function linuxSandboxArguments(
  policy: IsolationPolicy,
  argv: string[],
  masks: string[],
): string[] {
  const workspace = policy.workspace;
  return [
    BWRAP,
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    ...networkArgs(policy.network !== "allowed"),
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
    ...masks,
    "--bind",
    workspace,
    workspace,
    ...[
      ...policy.read.runtime,
      ...policy.read.transcripts,
      ...policy.read.artifacts,
      ...policy.read.hooks,
    ].flatMap((path) => ["--ro-bind", path, path]),
    ...(policy.write.runtime
      ? ["--bind", policy.write.runtime, policy.write.runtime]
      : []),
    ...policy.write.caches.flatMap((path) => ["--bind", path, path]),
    "--chdir",
    workspace,
    "--",
    ...argv,
  ];
}
