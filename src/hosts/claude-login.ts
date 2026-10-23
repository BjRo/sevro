import { createHash } from "node:crypto";
import { isRecord, isStringArray } from "../value-guards";

/** A claude.ai OAuth login in the document form Claude Code persists. */
export interface ClaudeLogin {
  document: Record<string, unknown>;
  oauth: Record<string, unknown>;
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: number | undefined;
  scopes: string[];
}

/** Fields replaced by a rotation; every other stored field is preserved. */
const ROTATED_FIELDS = [
  "accessToken",
  "refreshToken",
  "expiresAt",
  "scopes",
  "refreshTokenExpiresAt",
] as const;

/** Parse a stored login without echoing any of its bytes in errors. */
export function parseClaudeLogin(bytes: Buffer): ClaudeLogin {
  const document = loginDocument(bytes);
  const oauth = document.claudeAiOauth;
  if (!isRecord(oauth) || !nonblank(oauth.accessToken))
    throw new Error("Claude credential has no claude.ai login");
  return {
    document,
    oauth,
    accessToken: oauth.accessToken,
    refreshToken: nonblank(oauth.refreshToken) ? oauth.refreshToken : undefined,
    expiresAt: loginExpiry(oauth.expiresAt),
    scopes: isStringArray(oauth.scopes) ? oauth.scopes : [],
  };
}

function loginDocument(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    // Parser messages quote input, so the cause is deliberately not retained.
    throw new Error("Claude credential is not a JSON login document");
  }
  if (!isRecord(value))
    throw new Error("Claude credential is not a JSON login document");
  return value;
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function loginExpiry(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** A login without a recorded expiry is treated as not expiring. */
export function coversLifetime(
  login: ClaudeLogin,
  lifetimeMs: number,
  now = Date.now(),
): boolean {
  return login.expiresAt === undefined || login.expiresAt - now >= lifetimeMs;
}

/** Apply a rotated token pair to the latest stored document. */
export function rotatedLoginBytes(
  latest: ClaudeLogin,
  rotated: ClaudeLogin,
): Buffer {
  const oauth = { ...latest.oauth };
  for (const field of ROTATED_FIELDS)
    if (Object.hasOwn(rotated.oauth, field))
      oauth[field] = rotated.oauth[field];
  return Buffer.from(
    JSON.stringify({ ...latest.document, claudeAiOauth: oauth }),
  );
}

/** Rotated token fields, as retained for recovery. */
export function rotatedOAuth(login: ClaudeLogin): Record<string, unknown> {
  return Object.fromEntries(
    ROTATED_FIELDS.filter((field) => Object.hasOwn(login.oauth, field)).map(
      (field) => [field, login.oauth[field]],
    ),
  );
}

export function sameTokens(left: ClaudeLogin, right: ClaudeLogin): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt
  );
}

/** Identify a refresh token without retaining its value. */
export function tokenDigest(token: string | undefined): string {
  return createHash("sha256")
    .update(token ?? "")
    .digest("hex");
}
