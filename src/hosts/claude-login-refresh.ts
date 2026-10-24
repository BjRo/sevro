import { spawn } from "../runtime-process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { parseClaudeLogin, type ClaudeLogin } from "./claude-login";
import { MAX_CREDENTIAL_BYTES } from "./claude-login-store";

/** First Claude Code release verified to provide refresh-token login. */
export const CLAUDE_REFRESH_MINIMUM_VERSION = "2.1.284";
const MINIMUM_VERSION = [2, 1, 284] as const;
const VERSION_TIMEOUT_MS = 10_000;
const HELPER_TIMEOUT_MS = 60_000;
/** Network settings the operator may need to reach Anthropic's token endpoint. */
const FORWARDED_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
] as const;
/**
 * Claude resolves `security` through PATH. Refusing it makes the helper keep
 * the rotated login in its private credential file instead of a Keychain item.
 */
const SECURITY_STUB =
  '#!/bin/sh\n[ "$1" = find-generic-password ] && exit 44\nexit 1\n';

/**
 * Exchange the login's refresh token with Claude Code's documented
 * `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` login in a disposable configuration.
 * The caller owns the lock, durable writeback, and recovery.
 */
export async function refreshClaudeLogin(
  binary: string,
  login: ClaudeLogin & { refreshToken: string },
  workRoot: string,
): Promise<ClaudeLogin> {
  await requireRefreshCapableClaude(binary);
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const helper = await mkdtemp(join(workRoot, "refresh-"));
  try {
    const paths = await prepareHelper(helper);
    const code = await runHelper(binary, helperEnvironment(paths, login));
    return await storedRotation(paths.config, login, code);
  } finally {
    await rm(helper, { recursive: true, force: true });
  }
}

async function requireRefreshCapableClaude(binary: string): Promise<void> {
  const version = await claudeVersion(binary);
  if (!version || !atLeastMinimum(version))
    throw new Error(
      `Refreshing the saved Claude login requires Claude Code ${CLAUDE_REFRESH_MINIMUM_VERSION} or later`,
    );
}

async function claudeVersion(binary: string): Promise<number[] | undefined> {
  const proc = spawn([binary, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, VERSION_TIMEOUT_MS);
  try {
    const [output, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
    return code === 0 && match ? match.slice(1).map(Number) : undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function atLeastMinimum(version: number[]): boolean {
  for (const [index, minimum] of MINIMUM_VERSION.entries()) {
    const part = version[index] ?? 0;
    if (part !== minimum) return part > minimum;
  }
  return true;
}

async function prepareHelper(helper: string) {
  const paths = {
    config: join(helper, "config"),
    home: join(helper, "home"),
    bin: join(helper, "bin"),
  };
  await Promise.all(
    Object.values(paths).map((path) => mkdir(path, { mode: 0o700 })),
  );
  await writeFile(join(paths.bin, "security"), SECURITY_STUB, {
    flag: "wx",
    mode: 0o700,
  });
  return paths;
}

function helperEnvironment(
  paths: Awaited<ReturnType<typeof prepareHelper>>,
  login: ClaudeLogin & { refreshToken: string },
): Record<string, string> {
  const forwarded = Object.fromEntries(
    FORWARDED_VARIABLES.flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, value]] : [];
    }),
  );
  return {
    ...forwarded,
    PATH: [paths.bin, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
    HOME: paths.home,
    TMPDIR: paths.home,
    LANG: process.env.LANG ?? "C",
    NO_COLOR: "1",
    CLAUDE_CONFIG_DIR: paths.config,
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: login.refreshToken,
    CLAUDE_CODE_OAUTH_SCOPES: login.scopes.join(" "),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** Output is discarded: it is never needed and must not reach evidence. */
async function runHelper(
  binary: string,
  env: Record<string, string>,
): Promise<number> {
  const proc = spawn([binary, "auth", "login"], {
    env,
    cwd: env.HOME,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, HELPER_TIMEOUT_MS);
  try {
    return await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}

/** Accept only a persisted rotation; exit status alone proves nothing. */
async function storedRotation(
  config: string,
  login: ClaudeLogin,
  code: number,
): Promise<ClaudeLogin> {
  const rotated = await helperLogin(join(config, ".credentials.json"));
  if (!rotated?.refreshToken || rotated.accessToken === login.accessToken)
    throw new Error(
      `Claude could not refresh the saved login (helper exit ${String(code)}); run claude and /login if it has expired`,
    );
  return rotated;
}

async function helperLogin(path: string): Promise<ClaudeLogin | undefined> {
  try {
    if ((await stat(path)).size > MAX_CREDENTIAL_BYTES) return undefined;
    return parseClaudeLogin(await readFile(path));
  } catch {
    return undefined;
  }
}
