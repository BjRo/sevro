import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeAccessToken,
  stageClaudeAuthentication,
} from "../src/hosts/claude-credential";
import { atLeastMinimum } from "../src/hosts/claude-login-refresh";
import { withClaudeRefreshLock } from "../src/hosts/claude-refresh-lock";
import { isRecord } from "../src/value-guards";
import {
  syntheticClaudeLogin,
  syntheticRefreshClaude,
} from "./fixtures/claude-login";
import {
  withAuthenticationEnvironment,
  withSyntheticKeychain,
} from "./fixtures/host-auth";

const roots: string[] = [];
const BUDGET_MS = 30 * 60_000;
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

/** A saved login file, its synthetic Claude CLI, and the token ledger. */
async function refreshFixture(
  login: string,
  settings: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-login-"));
  roots.push(root);
  const ledger = join(root, "ledger");
  const config = join(root, "config");
  await Promise.all([mkdir(ledger), mkdir(config)]);
  const file = join(config, ".credentials.json");
  await writeFile(file, login, { mode: 0o600 });
  const binary = await syntheticRefreshClaude(root, {
    SEVRO_TEST_OAUTH_LEDGER: ledger,
    ...settings,
  });
  return { root, file, config, binary, ledger };
}

async function storedOAuth(file: string): Promise<Record<string, unknown>> {
  const document: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(document) || !isRecord(document.claudeAiOauth))
    throw new Error("missing stored login");
  return document.claudeAiOauth;
}

async function ledgerLines(ledger: string, name: string): Promise<string[]> {
  try {
    return (await readFile(join(ledger, name), "utf8"))
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function access(file: string, binary: string, lifetimeMs = BUDGET_MS) {
  return claudeAccessToken(file, { binary, lifetimeMs });
}

test("a fresh saved Claude login yields only its access token", async () => {
  const fixture = await refreshFixture(syntheticClaudeLogin());
  const staged = await stageClaudeAuthentication(
    join(fixture.root, "private"),
    fixture.file,
    { binary: fixture.binary, lifetimeMs: BUDGET_MS },
  );
  expect(staged.environment).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: "PRIVATE_TEST_LOGIN",
  });
  expect(stat(staged.credentialFile)).rejects.toThrow();
  expect(await ledgerLines(fixture.ledger, "requests")).toEqual([]);
  expect((await storedOAuth(fixture.file)).refreshToken).toBe(
    "PRIVATE_TEST_REFRESH",
  );
});

test("the parent refreshes an expiring login and durably rotates its store", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({
      expiresInMs: 20 * 60_000,
      extra: { mcpOAuth: { server: "PRESERVED_SENTINEL" } },
    }),
  );
  expect(await access(fixture.file, fixture.binary)).toBe("ROTATED_ACCESS_1");
  const document = JSON.parse(await readFile(fixture.file, "utf8")) as unknown;
  expect(document).toMatchObject({
    mcpOAuth: { server: "PRESERVED_SENTINEL" },
    claudeAiOauth: {
      accessToken: "ROTATED_ACCESS_1",
      refreshToken: "ROTATED_REFRESH_1",
      subscriptionType: "max",
    },
  });
  expect((await stat(fixture.file)).mode & 0o777).toBe(0o600);
  expect(await ledgerLines(fixture.ledger, "requests")).toEqual([
    "PRIVATE_TEST_REFRESH",
  ]);
  // The helper saw a refusing Keychain, never the operator's.
  expect(await ledgerLines(fixture.ledger, "security")).toEqual(["44"]);
  expect(await readdir(fixture.config)).toEqual([".credentials.json"]);
  expect(await access(fixture.file, fixture.binary)).toBe("ROTATED_ACCESS_1");
  expect(await ledgerLines(fixture.ledger, "requests")).toHaveLength(1);
});

test("concurrent Claude trials refresh one due login exactly once", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
    { SEVRO_TEST_OAUTH_MODE: "slow" },
  );
  const tokens = await Promise.all(
    [1, 2, 3].map(async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures/claude-access-token.ts"),
          fixture.file,
          fixture.binary,
          String(BUDGET_MS),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      return stdout;
    }),
  );
  expect(new Set(tokens)).toEqual(new Set(["ROTATED_ACCESS_1"]));
  expect(await ledgerLines(fixture.ledger, "requests")).toHaveLength(1);
});

test("an unwritable store retains the rotation and the next run restores it", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  const store = join(fixture.root, "store");
  await mkdir(store);
  const canonical = join(store, "login.json");
  await writeFile(canonical, await readFile(fixture.file), { mode: 0o600 });
  await rm(fixture.file);
  await symlink(canonical, fixture.file);
  await chmod(store, 0o500);
  roots.push(store);
  expect(access(fixture.file, fixture.binary)).rejects.toThrow(
    /could not update .*retained the refreshed login at .*restores it/,
  );
  expect((await storedOAuth(canonical)).refreshToken).toBe(
    "PRIVATE_TEST_REFRESH",
  );
  await chmod(store, 0o700);
  expect(await access(fixture.file, fixture.binary)).toBe("ROTATED_ACCESS_1");
  expect((await storedOAuth(canonical)).refreshToken).toBe("ROTATED_REFRESH_1");
  // Recovery replaced the consumed token without a second exchange.
  expect(await ledgerLines(fixture.ledger, "requests")).toHaveLength(1);
});

test("a pending rotation never overwrites a newer operator login", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  const store = join(fixture.root, "store");
  await mkdir(store);
  const canonical = join(store, "login.json");
  await writeFile(canonical, await readFile(fixture.file), { mode: 0o600 });
  await rm(fixture.file);
  await symlink(canonical, fixture.file);
  await chmod(store, 0o500);
  roots.push(store);
  expect(access(fixture.file, fixture.binary)).rejects.toThrow(/retained/);
  await chmod(store, 0o700);
  await writeFile(
    canonical,
    syntheticClaudeLogin({
      accessToken: "OPERATOR_ACCESS",
      refreshToken: "OPERATOR_REFRESH",
    }),
  );
  expect(await access(fixture.file, fixture.binary)).toBe("OPERATOR_ACCESS");
  expect(await access(fixture.file, fixture.binary)).toBe("OPERATOR_ACCESS");
  expect((await storedOAuth(canonical)).refreshToken).toBe("OPERATOR_REFRESH");
});

test("a login replaced during refresh keeps the operator's newer login", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  const binary = await syntheticRefreshClaude(fixture.root, {
    SEVRO_TEST_OAUTH_LEDGER: fixture.ledger,
    SEVRO_TEST_OAUTH_MODE: "relogin",
    SEVRO_TEST_CANONICAL: fixture.file,
  });
  expect(await access(fixture.file, binary)).toBe("ROTATED_ACCESS_1");
  expect((await storedOAuth(fixture.file)).refreshToken).toBe(
    "OPERATOR_RELOGIN_REFRESH",
  );
});

test("a refresh that stores no rotation cannot launch a trial", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
    { SEVRO_TEST_OAUTH_MODE: "consume-only" },
  );
  expect(access(fixture.file, fixture.binary)).rejects.toThrow(
    /could not refresh the saved login \(helper exit 1\); run claude and \/login/,
  );
  expect((await storedOAuth(fixture.file)).refreshToken).toBe(
    "PRIVATE_TEST_REFRESH",
  );
});

test("Claude releases before refresh-token login cannot refresh", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
    { SEVRO_TEST_CLAUDE_VERSION: "2.1.283" },
  );
  expect(access(fixture.file, fixture.binary)).rejects.toThrow(
    /requires Claude Code 2\.1\.284 or later/,
  );
  expect(await ledgerLines(fixture.ledger, "requests")).toEqual([]);
  expect([
    atLeastMinimum([2, 1, 284]),
    atLeastMinimum([2, 2, 0]),
    atLeastMinimum([3, 0, 0]),
    atLeastMinimum([2, 1, 283]),
    atLeastMinimum([1, 9, 999]),
    atLeastMinimum([2, 1]),
  ]).toEqual([true, true, true, false, false, false]);
  const unknown = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
    { SEVRO_TEST_CLAUDE_VERSION: "unknown" },
  );
  expect(access(unknown.file, unknown.binary)).rejects.toThrow(
    /requires Claude Code 2\.1\.284 or later/,
  );
});

test("a login is refreshed when it cannot cover the whole execution budget", async () => {
  const outside = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: 40 * 60_000 }),
  );
  expect(await access(outside.file, outside.binary)).toBe("PRIVATE_TEST_LOGIN");
  expect(await access(outside.file, outside.binary, 45 * 60_000)).toBe(
    "ROTATED_ACCESS_1",
  );
  const short = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
    { SEVRO_TEST_OAUTH_LIFETIME_MS: "60000" },
  );
  expect(access(short.file, short.binary)).rejects.toThrow(
    /cannot cover the 30-minute execution budget/,
  );
  // The short rotation is still persisted rather than lost.
  expect((await storedOAuth(short.file)).refreshToken).toBe(
    "ROTATED_REFRESH_1",
  );
});

test("expired logins without refresh authority ask for a new login", async () => {
  for (const login of [
    syntheticClaudeLogin({ expiresInMs: -60_000, refreshToken: null }),
    syntheticClaudeLogin({ expiresInMs: -60_000, scopes: [] }),
  ]) {
    const fixture = await refreshFixture(login);
    expect(access(fixture.file, fixture.binary)).rejects.toThrow(
      /expired and cannot be refreshed; run claude and \/login/,
    );
  }
});

test("invalid saved logins are refused without echoing their contents", async () => {
  for (const login of [
    "not-json PRIVATE_DOCUMENT_SECRET",
    '["PRIVATE_DOCUMENT_SECRET"]',
    '{"claudeAiOauth":{"refreshToken":"PRIVATE_DOCUMENT_SECRET"}}',
  ]) {
    const fixture = await refreshFixture(login);
    const failure = await access(fixture.file, fixture.binary).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/JSON login document|no claude\.ai login/);
    expect(String(failure)).not.toContain("PRIVATE_DOCUMENT_SECRET");
  }
});

test("the refresh lock waits for live holders and reclaims abandoned ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-lock-"));
  roots.push(root);
  const lock = join(root, ".oauth_refresh.lock");
  await mkdir(lock);
  expect(
    withClaudeRefreshLock(root, () => Promise.resolve("acquired"), {
      waitMs: 400,
    }),
  ).rejects.toThrow(/Timed out waiting for another process/);
  const abandoned = new Date(Date.now() - 120_000);
  await utimes(lock, abandoned, abandoned);
  const touched = await withClaudeRefreshLock(
    root,
    async () => {
      const before = (await stat(lock)).mtimeMs;
      await Bun.sleep(150);
      return (await stat(lock)).mtimeMs > before;
    },
    { waitMs: 1_000, updateMs: 20 },
  );
  expect(touched).toBe(true);
  expect(stat(lock)).rejects.toThrow();
  const readOnly = join(root, "read-only");
  await mkdir(readOnly, { mode: 0o500 });
  expect(
    withClaudeRefreshLock(readOnly, () => Promise.resolve(0)),
  ).rejects.toThrow(/refresh lock is unavailable/);
});

/** Run with a synthetic Keychain item for the fixture's configuration. */
async function withKeychainLogin<T>(
  fixture: Awaited<ReturnType<typeof refreshFixture>>,
  mode: string,
  action: () => T | Promise<T>,
): Promise<T> {
  return withAuthenticationEnvironment(
    {
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CONFIG_DIR: fixture.config,
      USER: "quality-account",
      SEVRO_QUALITY_SECURITY_STORE: join(fixture.root, "keychain-item"),
    },
    () => withSyntheticKeychain(mode, true, action),
  );
}

test("macOS Keychain logins are refreshed in their own item", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await refreshFixture(syntheticClaudeLogin());
  await rm(fixture.file);
  const item = join(fixture.root, "keychain-item");
  // Large enough that the update leaves `security -i` for argv, as Claude does.
  await writeFile(
    item,
    syntheticClaudeLogin({
      expiresInMs: -60_000,
      extra: { mcpOAuth: { sentinel: "x".repeat(3_000) } },
    }),
  );
  await withKeychainLogin(fixture, "expired", async () => {
    expect(await access("", fixture.binary)).toBe("ROTATED_ACCESS_1");
  });
  expect(await storedOAuth(item)).toMatchObject({
    refreshToken: "ROTATED_REFRESH_1",
    subscriptionType: "max",
  });
  expect(await readFile(item, "utf8")).toContain("x".repeat(3_000));
  expect(await readdir(fixture.config)).toEqual([]);
});

test("an unwritable Keychain item retains the rotation for the next run", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await refreshFixture(syntheticClaudeLogin());
  await rm(fixture.file);
  const item = join(fixture.root, "keychain-item");
  await withKeychainLogin(fixture, "expired-readonly", () => {
    expect(access("", fixture.binary)).rejects.toThrow(
      /could not update macOS Keychain item "Claude Code-credentials-[0-9a-f]{8}"; Sevro retained/,
    );
  });
  expect(stat(item)).rejects.toThrow();
  await withKeychainLogin(fixture, "expired", async () => {
    expect(await access("", fixture.binary)).toBe("ROTATED_ACCESS_1");
  });
  expect((await storedOAuth(item)).refreshToken).toBe("ROTATED_REFRESH_1");
  expect(await ledgerLines(fixture.ledger, "requests")).toHaveLength(1);
});

test("Keychain read failures fall back only to an existing saved file", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await refreshFixture(syntheticClaudeLogin());
  await withKeychainLogin(fixture, "failure", async () => {
    expect(await access("", fixture.binary)).toBe("PRIVATE_TEST_LOGIN");
  });
  await withKeychainLogin(fixture, "missing", async () => {
    expect(await access("", fixture.binary)).toBe("PRIVATE_TEST_LOGIN");
  });
  await rm(fixture.file);
  await withKeychainLogin(fixture, "missing", () => {
    expect(access("", fixture.binary)).rejects.toThrow(
      /saved login is unavailable; run claude and \/login/,
    );
  });
});

test("an oversized helper login is not accepted as a rotation", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
    { SEVRO_TEST_OAUTH_MODE: "oversized" },
  );
  expect(access(fixture.file, fixture.binary)).rejects.toThrow(
    /could not refresh the saved login \(helper exit 0\)/,
  );
});

test("the refresh helper receives the operator's network settings only", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  await withAuthenticationEnvironment(
    { HTTPS_PROXY: "http://127.0.0.1:9", SEVRO_UNRELATED: "unrelated" },
    async () => {
      expect(await access(fixture.file, fixture.binary)).toBe(
        "ROTATED_ACCESS_1",
      );
    },
  );
  expect(await ledgerLines(fixture.ledger, "proxy")).toEqual([
    "http://127.0.0.1:9",
  ]);
});

test("a Keychain update that is not applied fails persistence verification", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await refreshFixture(syntheticClaudeLogin());
  await rm(fixture.file);
  await withKeychainLogin(fixture, "expired-ignored", () => {
    expect(access("", fixture.binary)).rejects.toThrow(
      /could not update macOS Keychain item .*Sevro retained/,
    );
  });
});
