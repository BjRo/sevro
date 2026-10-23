import { join } from "node:path";
import { chmod, writeFile } from "node:fs/promises";

export const SYNTHETIC_SCOPES = ["user:inference", "user:profile"];

interface SyntheticLoginOptions {
  accessToken?: string;
  refreshToken?: string | null;
  expiresInMs?: number;
  scopes?: string[];
  extra?: Record<string, unknown>;
}

/** A synthetic claude.ai login in Claude Code's stored document form. */
export function syntheticClaudeLogin(
  options: SyntheticLoginOptions = {},
): string {
  return JSON.stringify({
    ...options.extra,
    claudeAiOauth: {
      accessToken: options.accessToken ?? "PRIVATE_TEST_LOGIN",
      ...refreshField(options.refreshToken),
      expiresAt: Date.now() + (options.expiresInMs ?? 365 * 24 * 3_600_000),
      scopes: options.scopes ?? SYNTHETIC_SCOPES,
      subscriptionType: "max",
    },
  });
}

function refreshField(refreshToken: string | null | undefined) {
  return refreshToken === null
    ? {}
    : { refreshToken: refreshToken ?? "PRIVATE_TEST_REFRESH" };
}

/**
 * Write an executable `claude` that runs the synthetic refresh endpoint. The
 * parent passes the helper a minimal environment, so test settings are baked
 * into the wrapper rather than inherited.
 */
export async function syntheticRefreshClaude(
  root: string,
  settings: Record<string, string>,
): Promise<string> {
  const binary = join(root, "claude");
  const exports = Object.entries(settings)
    .map(([name, value]) => `export ${name}='${value.replaceAll("'", "")}'\n`)
    .join("");
  await writeFile(
    binary,
    `#!/bin/sh\n${exports}exec "${process.execPath}" "${join(import.meta.dir, "claude-refresh.ts")}" "$@"\n`,
  );
  await chmod(binary, 0o700);
  return binary;
}
