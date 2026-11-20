import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  requireNativeTranscriptViews,
  requireNativeHookRoots,
  requireRuntimeReadRoots,
  requireWritableCacheRoots,
  requireCandidateArtifactRoots,
} from "../runtime/index";
import {
  commandRuntimeRoot,
  HostIsolationError,
  requireDisjointState,
  requireIsolationPaths,
  type IsolatedCommand,
  type IsolationOptions,
} from "./isolation-common";

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
  options: IsolationOptions,
): Promise<IsolatedCommand> {
  requireLinuxSandbox();
  await requireNativeTranscriptViews(options.transcriptReadRoots);
  await requireCandidateArtifactRoots(options.candidateArtifactRoots);
  await requireNativeHookRoots(options.hookReadRoots, options.privateStateRoot);
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
  const writableCacheRoots = await cacheMountRoots(options, [
    ...roots,
    stateRoot,
  ]);
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
      argv: linuxSandboxArguments(options, {
        workspace,
        masks,
        readRoots,
        ownedRoot,
        writableCacheRoots,
      }),
      release: async () => {
        await rm(blockedFile, { force: true });
      },
    };
  } catch (error) {
    await rm(blockedFile, { force: true });
    throw error;
  }
}

function cacheMountRoots(options: IsolationOptions, protectedRoots: string[]) {
  return requireWritableCacheRoots(
    options.writableCacheRoots ?? [],
    protectedRoots,
  );
}

function transcriptMounts(options: IsolationOptions): string[] {
  return (options.transcriptReadRoots ?? []).flatMap((path) => [
    "--ro-bind",
    path,
    path,
  ]);
}

function candidateArtifactMounts(options: IsolationOptions): string[] {
  return Object.values(options.candidateArtifactRoots ?? {}).flatMap((path) => [
    "--ro-bind",
    path,
    path,
  ]);
}

function hookMounts(options: IsolationOptions): string[] {
  return (options.hookReadRoots ?? []).flatMap((path) => [
    "--ro-bind",
    path,
    path,
  ]);
}

/** Render the Linux launch without spawning a sandbox. */
export function linuxSandboxArguments(
  options: IsolationOptions,
  mounts: {
    workspace: string;
    masks: string[];
    readRoots: string[];
    ownedRoot?: string;
    writableCacheRoots: string[];
  },
): string[] {
  const { workspace, masks, readRoots, ownedRoot, writableCacheRoots } = mounts;
  return [
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
    ...masks,
    "--bind",
    workspace,
    workspace,
    ...readRoots.flatMap((path) => ["--ro-bind", path, path]),
    ...transcriptMounts(options),
    ...candidateArtifactMounts(options),
    ...hookMounts(options),
    ...(ownedRoot ? ["--bind", ownedRoot, ownedRoot] : []),
    ...writableCacheRoots.flatMap((path) => ["--bind", path, path]),
    "--chdir",
    workspace,
    "--",
    ...options.argv,
  ];
}
