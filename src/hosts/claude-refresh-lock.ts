import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, rmdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

/**
 * Claude Code serializes OAuth refresh through this directory lock in the
 * configuration directory. These values match its lockfile settings, observed
 * in Claude Code 2.1.284 and 2.1.309: stale after 60s, refreshed every 5s.
 */
const LOCK_NAME = ".oauth_refresh.lock";
const STALE_MS = 60_000;
const UPDATE_MS = 5_000;
const RETRY_MS = 250;
const DEFAULT_WAIT_MS = 120_000;

/** Run an action while holding the refresh lock Claude Code also honors. */
export async function withClaudeRefreshLock<T>(
  root: string,
  action: () => Promise<T>,
  { waitMs = DEFAULT_WAIT_MS, updateMs = UPDATE_MS } = {},
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, LOCK_NAME);
  await acquireLock(lock, Date.now() + waitMs);
  const heartbeat = setInterval(() => {
    void touchLock(lock);
  }, updateMs);
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(lock);
  }
}

async function acquireLock(lock: string, deadline: number): Promise<void> {
  while (!(await createLock(lock))) {
    if (Date.now() >= deadline)
      throw new Error(
        "Timed out waiting for another process to refresh the Claude login",
      );
    await sleep(RETRY_MS);
  }
}

async function createLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST")
      throw new Error("Claude refresh lock is unavailable", { cause });
  }
  await removeStaleLock(lock);
  return false;
}

/** An abandoned holder stops touching the lock; reclaim it as Claude does. */
async function removeStaleLock(lock: string): Promise<void> {
  try {
    if (Date.now() - (await stat(lock)).mtimeMs > STALE_MS) await rmdir(lock);
  } catch {
    // Another contender released or reclaimed it first.
  }
}

async function touchLock(lock: string): Promise<void> {
  const now = new Date();
  try {
    await utimes(lock, now, now);
  } catch {
    // Release or reclamation races are resolved by the post-lock re-read.
  }
}

async function releaseLock(lock: string): Promise<void> {
  try {
    await rmdir(lock);
  } catch {
    // Already removed; the heartbeat keeps a live holder from being reclaimed.
  }
}
