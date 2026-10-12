import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { requireNativeTranscriptViews } from "../native-transcript-state";
import { requireCandidateArtifactRoots } from "../candidate-artifacts";
import { workspaceBoundaryException } from "../workspace-state";
import {
  insideRuntimeRoot,
  isRuntimeHomeRoot,
  requireRuntimeReadRoots,
} from "../runtime-paths";
import {
  commandRuntimeRoot,
  HostIsolationError,
  requireDisjointState,
  requireIsolationPaths,
  type IsolatedCommand,
  type IsolationOptions,
} from "./isolation-common";

export { HostIsolationError } from "./isolation-common";
export type { IsolatedCommand } from "./isolation-common";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function quoted(path: string): string {
  if (
    Array.from(path).some(
      (character) =>
        character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  )
    throw new HostIsolationError("sandbox path contains a control character");
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Deny both observation and mutation of every protected canonical root. */
export function macSandboxProfile(
  deniedRoots: string[],
  denyNetwork = false,
  readOnlyRoots: string[] = [],
  writableRuntimeRoot?: string,
  transcriptReadRoots: string[] = [],
  workspace?: string,
): string {
  requireProfileRoots(deniedRoots);
  return [
    "(version 1)",
    "(allow default)",
    ...(denyNetwork ? ["(deny network*)"] : []),
    ...[...new Set(deniedRoots)]
      .sort()
      .flatMap((path) => [
        `(deny file-read* ${workspaceReadFilter(path, [...readExceptions(path, readOnlyRoots, writableRuntimeRoot, transcriptReadRoots), ...workspaceBoundaryException(path, workspace)], workspace)})`,
        `(deny file-write* ${rootFilter(path, [...ownedException(path, writableRuntimeRoot), ...workspaceBoundaryException(path, workspace)])})`,
      ]),
    ...deniedRoots.flatMap((path) =>
      workspaceBoundaryException(path, workspace).map(
        () => `(deny file-read-data (literal "${quoted(path)}"))`,
      ),
    ),
    ...[...readOnlyRoots, ...transcriptReadRoots].map(
      (path) => `(deny file-write* (subpath "${quoted(path)}"))`,
    ),
    "",
  ].join("\n");
}

function requireProfileRoots(roots: string[]): void {
  if (!roots.length || roots.some((path) => !path.startsWith("/")))
    throw new HostIsolationError("sandbox roots must be absolute and nonempty");
}

function readExceptions(
  root: string,
  readRoots: string[],
  writableRuntimeRoot: string | undefined,
  transcriptReadRoots: string[],
): string[] {
  const exceptions = isRuntimeHomeRoot(root)
    ? readRoots.filter((path) => insideRuntimeRoot(root, path))
    : [];
  return [
    ...transcriptReadRoots.filter((path) => insideRuntimeRoot(root, path)),
    ...exceptions,
    ...ownedException(root, writableRuntimeRoot),
  ];
}

function rootFilter(root: string, exceptions: string[]): string {
  const base = `(subpath "${quoted(root)}")`;
  if (!exceptions.length) return base;
  return `(require-all ${base} ${exceptions.map((path) => `(require-not (subpath "${quoted(path)}"))`).join(" ")})`;
}

function workspaceReadFilter(
  root: string,
  exceptions: string[],
  workspace?: string,
): string {
  const filter = rootFilter(root, exceptions);
  return workspaceBoundaryException(root, workspace).length
    ? `(require-all ${filter} (require-not (literal "${quoted(root)}")))`
    : filter;
}

function ownedException(root: string, ownedRoot: string | undefined): string[] {
  if (ownedRoot && insideRuntimeRoot(root, ownedRoot)) return [ownedRoot];
  return [];
}

/** Build the outer boundary before launching an agent or candidate-controlled code. */
export async function prepareMacSandboxCommand(
  options: IsolationOptions,
): Promise<IsolatedCommand> {
  requireSandboxAvailable();
  await requireNativeTranscriptViews(options.transcriptReadRoots);
  await requireCandidateArtifactRoots(options.candidateArtifactRoots);
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
  const profilePath = resolve(stateRoot, `host-${randomUUID()}.sb`);
  await writeFile(
    profilePath,
    macSandboxProfile(
      [...roots, stateRoot],
      options.denyNetwork,
      readRoots,
      ownedRoot,
      [
        ...(options.transcriptReadRoots ?? []),
        ...Object.values(options.candidateArtifactRoots ?? {}),
      ],
      workspace,
    ),
    { flag: "wx", mode: 0o600 },
  );
  return {
    argv: [SANDBOX_EXEC, "-f", profilePath, ...options.argv],
    release: async () => {
      await rm(profilePath, { force: true });
    },
  };
}

function requireSandboxAvailable(): void {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC))
    throw new HostIsolationError("macOS sandbox-exec isolation is unavailable");
}
