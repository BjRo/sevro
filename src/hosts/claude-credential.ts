import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { nativeStateParent } from "../native-transcript-state";
import {
  coversLifetime,
  parseClaudeLogin,
  rotatedLoginBytes,
  sameTokens,
  tokenDigest,
  type ClaudeLogin,
} from "./claude-login";
import {
  claudeLoginRecovery,
  type ClaudeLoginRecovery,
} from "./claude-login-recovery";
import { refreshClaudeLogin } from "./claude-login-refresh";
import {
  claudeLoginStore,
  MAX_CREDENTIAL_BYTES,
  requireBoundedCredential,
  type ClaudeKeychain,
  type ClaudeLoginStore,
} from "./claude-login-store";
import { withClaudeRefreshLock } from "./claude-refresh-lock";

export const CLAUDE_AUTH_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** Margin beyond the execution budget, matching Claude's own refresh window. */
export const CLAUDE_LOGIN_MARGIN_MS = 5 * 60_000;

/** What a saved login must provide before a trial may use it. */
export interface ClaudeLoginRequirement {
  /** Claude binary used for parent-owned refresh. */
  binary: string;
  /** Remaining access-token lifetime the complete execution needs. */
  lifetimeMs: number;
}

/** Keep the CLI's authentication separate from the candidate tool environment. */
export async function stageClaudeAuthentication(
  configRoot: string,
  sourceFile: string | undefined,
  requirement: ClaudeLoginRequirement,
) {
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  const environment = authenticationEnvironment(sourceFile);
  if (!Object.keys(environment).length)
    environment.CLAUDE_CODE_OAUTH_TOKEN = await claudeAccessToken(
      sourceFile,
      requirement,
    );
  return {
    // Trials never receive a saved login; the path only anchors private state.
    credentialFile: join(configRoot, ".credentials.json"),
    environment,
  };
}

function boundedEnvironmentCredential(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_BYTES)
    throw new Error("Claude environment credential exceeds the size limit");
  return value;
}

function authenticationEnvironment(sourceFile: string | undefined) {
  const environment: Record<string, string> = {};
  if (sourceFile === undefined) {
    for (const name of CLAUDE_AUTH_VARIABLES) {
      const value = process.env[name];
      if (value) {
        environment[name] = boundedEnvironmentCredential(value);
      }
    }
  }
  return environment;
}

async function platformKeychain(): Promise<ClaudeKeychain | undefined> {
  if (process.platform !== "darwin") return undefined;
  const { claudeKeychain } = await import("./claude-keychain");
  return claudeKeychain;
}

/**
 * Provide an access token from the selected saved login. The parent alone
 * refreshes it, so a rotating refresh token never enters disposable state.
 */
export async function claudeAccessToken(
  sourceFile: string | undefined,
  requirement: ClaudeLoginRequirement,
): Promise<string> {
  const store = await claudeLoginStore(sourceFile, await platformKeychain());
  const recovery = await claudeLoginRecovery(
    await nativeStateParent(),
    store.origin,
  );
  const login = await storedLogin(store);
  if (
    coversLifetime(login, requirement.lifetimeMs) &&
    !(await recovery.pending())
  )
    return login.accessToken;
  return withClaudeRefreshLock(store.lockRoot, () =>
    lockedAccessToken(store, recovery, requirement),
  );
}

async function storedLogin(store: ClaudeLoginStore): Promise<ClaudeLogin> {
  return parseClaudeLogin(requireBoundedCredential(await store.read()));
}

/** Re-read under the lock: another process may already have refreshed. */
async function lockedAccessToken(
  store: ClaudeLoginStore,
  recovery: ClaudeLoginRecovery,
  requirement: ClaudeLoginRequirement,
): Promise<string> {
  const current = await recoveredLogin(store, recovery);
  if (coversLifetime(current, requirement.lifetimeMs))
    return current.accessToken;
  const rotated = await refreshClaudeLogin(
    requirement.binary,
    refreshableLogin(current),
    recovery.workRoot,
  );
  await recovery.retain(current, rotated);
  await persistRotation(store, recovery, current, rotated);
  await recovery.discard();
  return usableAccessToken(rotated, requirement.lifetimeMs);
}

function refreshableLogin(
  login: ClaudeLogin,
): ClaudeLogin & { refreshToken: string } {
  const { refreshToken } = login;
  if (!refreshToken || !login.scopes.length)
    throw new Error(
      "Claude saved login has expired and cannot be refreshed; run claude and /login",
    );
  return { ...login, refreshToken };
}

function usableAccessToken(login: ClaudeLogin, lifetimeMs: number): string {
  if (!coversLifetime(login, lifetimeMs))
    throw new Error(
      `Claude login lifetime cannot cover the ${String(Math.ceil(lifetimeMs / 60_000))}-minute execution budget`,
    );
  return login.accessToken;
}

/** Complete a rotation left pending when its store could not be updated. */
async function recoveredLogin(
  store: ClaudeLoginStore,
  recovery: ClaudeLoginRecovery,
): Promise<ClaudeLogin> {
  const current = await storedLogin(store);
  const pending = await recovery.pending();
  if (!pending) return current;
  if (pending.replaces !== tokenDigest(current.refreshToken)) {
    // The store moved on through another login; never overwrite it.
    await recovery.discard();
    return current;
  }
  const rotated = parseClaudeLogin(
    rotatedLoginBytes(current, { ...current, oauth: pending.oauth }),
  );
  await writeVerified(store, recovery, current, rotated);
  await recovery.discard();
  return rotated;
}

/** Compare-and-swap against the refresh token the rotation consumed. */
async function persistRotation(
  store: ClaudeLoginStore,
  recovery: ClaudeLoginRecovery,
  replaced: ClaudeLogin,
  rotated: ClaudeLogin,
): Promise<void> {
  const latest = await storedLogin(store);
  if (latest.refreshToken !== replaced.refreshToken) return;
  await writeVerified(store, recovery, latest, rotated);
}

async function writeVerified(
  store: ClaudeLoginStore,
  recovery: ClaudeLoginRecovery,
  latest: ClaudeLogin,
  rotated: ClaudeLogin,
): Promise<void> {
  try {
    await store.write(rotatedLoginBytes(latest, rotated));
    if (!sameTokens(await storedLogin(store), rotated))
      throw new Error("the stored login does not match the rotation");
  } catch (cause) {
    throw new Error(
      `Claude refreshed the saved login but could not update ${store.origin}; Sevro retained the refreshed login at ${recovery.path} and restores it on the next run once the store is writable`,
      { cause },
    );
  }
}
