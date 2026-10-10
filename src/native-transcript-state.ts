import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, sep } from "node:path";

/** A permanent deny boundary also covers roles allocated after command launch. */
export async function nativeStateParent(): Promise<string> {
  const root = nativeStatePath();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  requirePrivateNamespace(info);
  return realpath(root);
}

/** Canonical base also binds declaration symlinks before any private tree is read. */
export function nativeStatePath(): string {
  return join(realpathSync(nativeStateBase()), "sevro-native-private");
}

export function nativeStateProtectedRoots(): string[] {
  return [nativeStatePath(), join(nativeStateBase(), "sevro-native-private")];
}

function nativeStateBase(): string {
  return process.platform === "linux" ? "/var/tmp" : tmpdir();
}

function requirePrivateNamespace(info: Stats): void {
  if (
    !info.isDirectory() ||
    info.uid !== userInfo().uid ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "native state namespace must be an owned private directory",
    );
}

export async function allocateNativeState(
  prefix: string,
  runtimeWorkspace?: string,
): Promise<string> {
  await requireExternalNativeNamespace(runtimeWorkspace);
  return realpath(await mkdtemp(join(await nativeStateParent(), prefix)));
}

/** Workspace writes must never reach existing or future native peer state. */
async function requireExternalNativeNamespace(
  workspace?: string,
): Promise<void> {
  if (workspace === undefined) return;
  const fixtureRoot = join(await realpath(workspace), sep);
  const namespaceRoot = join(nativeStatePath(), sep);
  if (
    fixtureRoot.startsWith(namespaceRoot) ||
    namespaceRoot.startsWith(fixtureRoot)
  )
    throw new Error("native runtime namespace overlaps the fixture workspace");
}

export async function requireNativeTranscriptView(
  root: string | undefined,
): Promise<void> {
  if (root === undefined) return;
  const parent = await nativeStateParent();
  if (
    dirname(root) !== parent ||
    !basename(root).startsWith("view-") ||
    (await realpath(root)) !== root
  )
    throw new Error(
      "native transcript view must be runner-owned and canonical",
    );
  requirePrivateNamespace(await lstat(root));
}

export async function requireNativeTranscriptViews(
  roots: string[] | undefined,
): Promise<void> {
  for (const root of roots ?? []) await requireNativeTranscriptView(root);
}

/** Curated hook copies are a separate runner-owned exception, never policy roots. */
export async function requireNativeHookRoots(
  roots: string[] | undefined,
): Promise<void> {
  for (const root of roots ?? []) await requireNativeHookRoot(root);
}

async function requireNativeHookRoot(root: string): Promise<void> {
  const parent = await nativeStateParent();
  const state = dirname(dirname(root));
  if (!nativeHookLayout(root, state, parent) || (await realpath(root)) !== root)
    throw new Error("native hook read root must be a canonical curated mount");
  const info = await lstat(root);
  if (!info.isDirectory() || info.uid !== userInfo().uid)
    throw new Error("native hook read root must be owned");
}

function nativeHookLayout(
  root: string,
  state: string,
  parent: string,
): boolean {
  return (
    dirname(state) === parent &&
    basename(state).startsWith("claude-") &&
    basename(dirname(root)) === "runtime-plugins" &&
    /^plugin-[0-9]+$/.test(basename(root))
  );
}
