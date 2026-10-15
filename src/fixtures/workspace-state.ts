import { realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ownerStatus,
  processIdentity,
  validProcessIdentity,
  type ProcessIdentity,
} from "../run-owner";
import { isRecord } from "../value-guards";
import { isMissingFile } from "./tools";
import { atomicWriteJson } from "../storage";
import { clearFixtureContents } from "./cleanup";

const RETENTION_MS = 24 * 60 * 60_000;
interface WorkspaceOwner {
  format: "sevro.workspace-owner.v1";
  owner: ProcessIdentity;
  state: "active" | "retained";
  timestamp: number;
}

/** One stable boundary protects both existing and subsequently allocated peers. */
export function workspaceStatePath(): string {
  const base = process.platform === "linux" ? "/var/tmp" : tmpdir();
  return join(realpathSync(base), "sevro-workspaces-private");
}

export async function workspaceStateParent(): Promise<string> {
  const root = workspaceStatePath();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.uid !== userInfo().uid ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("workspace namespace must be an owned private directory");
  return realpath(root);
}

export async function allocateWorkspace(): Promise<string> {
  const owner = processIdentity(process.pid);
  if (!owner) throw new Error("cannot verify workspace owner identity");
  const parent = await workspaceStateParent();
  await workspaceMetadataDirectory(parent);
  const workspace = await realpath(await mkdtemp(join(parent, "case-")));
  try {
    await writeFile(
      workspaceOwnerPath(workspace),
      JSON.stringify({
        format: "sevro.workspace-owner.v1",
        owner,
        state: "active",
        timestamp: Date.now(),
      }),
      { mode: 0o600, flag: "wx" },
    );
    return workspace;
  } catch (cause) {
    await rm(workspace, { recursive: true, force: true });
    throw cause;
  }
}

async function workspaceMetadataDirectory(parent: string): Promise<string> {
  const root = join(parent, ".owners");
  await mkdir(root, { mode: 0o700, recursive: true });
  const metadata = await lstat(root);
  if (!ownedDirectory(metadata) || (metadata.mode & 0o077) !== 0)
    throw new Error("workspace metadata must be an owned private directory");
  return root;
}

function workspaceOwnerPath(workspace: string): string {
  return join(dirname(workspace), ".owners", `${basename(workspace)}.json`);
}

function validWorkspaceLifecycle(value: Record<string, unknown>): boolean {
  return (
    (value.state === "active" || value.state === "retained") &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp)
  );
}

function validWorkspaceOwner(value: unknown): value is WorkspaceOwner {
  return (
    isRecord(value) &&
    value.format === "sevro.workspace-owner.v1" &&
    validWorkspaceLifecycle(value) &&
    validProcessIdentity(value.owner)
  );
}

function privateOwnerFile(info: Stats): boolean {
  return (
    info.isFile() &&
    info.uid === userInfo().uid &&
    info.size <= 4096 &&
    (info.mode & 0o077) === 0
  );
}

async function readWorkspaceOwner(workspace: string): Promise<unknown> {
  const path = workspaceOwnerPath(workspace);
  if (!privateOwnerFile(await lstat(path))) return null;
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function workspaceOwner(
  workspace: string,
): Promise<WorkspaceOwner | null> {
  try {
    const value = await readWorkspaceOwner(workspace);
    return validWorkspaceOwner(value) ? value : null;
  } catch {
    // Unreadable or malformed ownership cannot authorize temporary-data deletion.
    return null;
  }
}

export async function retainWorkspace(workspace: string): Promise<void> {
  if (!workspaceBoundaryException(workspaceStatePath(), workspace).length)
    return;
  const record = await workspaceOwner(workspace);
  if (!record || record.state === "retained") return;
  await atomicWriteJson(workspaceOwnerPath(workspace), {
    ...record,
    state: "retained",
    timestamp: Date.now(),
  });
}

export async function removeWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
  if (workspaceBoundaryException(workspaceStatePath(), workspace).length)
    await rm(workspaceOwnerPath(workspace), { force: true });
}

async function expireWorkspace(
  workspace: string,
  cutoff: number,
): Promise<void> {
  const record = await workspaceOwner(workspace);
  if (!record || !expiredOwner(record, cutoff)) return;
  const info = await lstat(workspace).catch((cause: unknown) => {
    if (isMissingFile(cause)) return null;
    throw cause;
  });
  if (info && !ownedDirectory(info)) return;
  await clearExpiredWorkspace(workspace, info);
}

async function clearExpiredWorkspace(
  workspace: string,
  info: Stats | null,
): Promise<void> {
  if (info) await clearFixtureContents(workspace);
  await removeWorkspace(workspace);
}

function ownedDirectory(info: Stats): boolean {
  return info.isDirectory() && info.uid === userInfo().uid;
}

function expiredOwner(record: WorkspaceOwner, cutoff: number): boolean {
  return (
    record.timestamp < cutoff &&
    (record.state === "retained" || ownerStatus(record.owner) === "dead")
  );
}

/** Reclaim only owned inactive temporary data; evidence directories are never scanned. */
export async function cleanupExpiredWorkspaces(): Promise<void> {
  const parent = await workspaceStateParent();
  const metadata = await workspaceMetadataDirectory(parent);
  const cutoff = Date.now() - RETENTION_MS;
  for (const entry of await readdir(metadata, { withFileTypes: true }))
    if (entry.isFile() && /^case-[a-zA-Z0-9]+\.json$/.test(entry.name)) {
      const workspace = join(parent, entry.name.slice(0, -5));
      await expireWorkspace(workspace, cutoff).catch((cause: unknown) => {
        if (!isMissingFile(cause))
          console.warn(
            `temporary workspace cleanup did not complete: ${workspace}`,
          );
      });
    }
}

/** Only a runner-owned direct child can be an exception to this deny boundary. */
export function workspaceBoundaryException(
  root: string,
  workspace?: string,
): string[] {
  return root === workspaceStatePath() &&
    workspace !== undefined &&
    dirname(workspace) === root
    ? [workspace]
    : [];
}
