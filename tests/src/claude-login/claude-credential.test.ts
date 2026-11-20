import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageClaudeAuthentication } from "../../../src/claude-login/index";
import { isRecord } from "../../../src/kernel/index";
import { nativeStateParent } from "../../../src/runtime/index";
import {
  syntheticClaudeLogin,
  syntheticRefreshClaude,
} from "../../fixtures/claude-login";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import {
  expectedClaudeKeychainService,
  withAuthenticationEnvironment,
  withSyntheticKeychain,
} from "../../fixtures/host-auth";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const BUDGET_MS = 30 * 60_000;
const LOCK_NAME = ".oauth_refresh.lock";

/** A saved login file, its synthetic Claude CLI, and the token ledger. */
async function refreshFixture(
  login: string,
  settings: Record<string, string> = {},
) {
  const root = await temporaryFixture(join(tmpdir(), "sevro-claude-login-"));

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

/** Stage one trial's authentication and return the only credential it gets. */
async function access(
  file: string | undefined,
  binary: string,
  lifetimeMs = BUDGET_MS,
): Promise<string | undefined> {
  const root = await temporaryFixture(join(tmpdir(), "sevro-claude-stage-"));
  const staged = await stageClaudeAuthentication(join(root, "config"), file, {
    binary,
    lifetimeMs,
  });
  expect(Object.keys(staged.environment)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  return staged.environment.CLAUDE_CODE_OAUTH_TOKEN;
}

/** The private recovery slot Sevro keeps for one store origin. */
async function recoveryRecord(origin: string): Promise<string> {
  const key = createHash("sha256").update(origin).digest("hex");
  return join(
    await nativeStateParent(),
    "claude-login-recovery",
    `${key}.json`,
  );
}

const recoveryRecords: string[] = [];
afterEach(async () => {
  await Promise.all(
    recoveryRecords.splice(0).map((path) => rm(path, { force: true })),
  );
});

/** Replace the saved login file with a symlink into a read-only store. */
async function readOnlyStore(
  fixture: Awaited<ReturnType<typeof refreshFixture>>,
) {
  const store = join(fixture.root, "store");
  await mkdir(store);
  const canonical = join(store, "login.json");
  await writeFile(canonical, await readFile(fixture.file), { mode: 0o600 });
  await rm(fixture.file);
  await symlink(canonical, fixture.file);
  await chmod(store, 0o500);
  return { store, canonical };
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
  expect(staged.credentialFile).toBe(
    join(fixture.root, "private", ".credentials.json"),
  );
  expect((await stat(join(fixture.root, "private"))).mode & 0o777).toBe(0o700);
  expect(stat(staged.credentialFile)).rejects.toThrow();
  expect(await ledgerLines(fixture.ledger, "requests")).toEqual([]);
  expect((await storedOAuth(fixture.file)).refreshToken).toBe(
    "PRIVATE_TEST_REFRESH",
  );
});

test("a selected saved login takes precedence over inherited credentials", async () => {
  const fixture = await refreshFixture(syntheticClaudeLogin());
  await withAuthenticationEnvironment(
    {
      ANTHROPIC_API_KEY: "INHERITED_API_KEY",
      CLAUDE_CODE_OAUTH_TOKEN: "INHERITED_TOKEN",
    },
    async () => {
      expect(await access(fixture.file, fixture.binary)).toBe(
        "PRIVATE_TEST_LOGIN",
      );
    },
  );
});

test("the parent refreshes an expiring login and durably rotates its store", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({
      expiresInMs: 20 * 60_000,
      extra: { mcpOAuth: { server: "PRESERVED_SENTINEL" } },
    }),
  );
  recoveryRecords.push(await recoveryRecord(fixture.file));
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
  // Neither a lock nor a temporary login nor a recovery record is left behind.
  expect(await readdir(fixture.config)).toEqual([".credentials.json"]);
  expect(stat(await recoveryRecord(fixture.file))).rejects.toThrow();
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
          join(import.meta.dir, "../../fixtures/claude-access-token.ts"),
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
  expect(tokens).toEqual([
    "ROTATED_ACCESS_1",
    "ROTATED_ACCESS_1",
    "ROTATED_ACCESS_1",
  ]);
  expect(await ledgerLines(fixture.ledger, "requests")).toHaveLength(1);
  expect(await readdir(fixture.config)).toEqual([".credentials.json"]);
});

test("an unwritable store retains the rotation and the next run restores it", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  const record = await recoveryRecord(fixture.file);
  recoveryRecords.push(record);
  const { store, canonical } = await readOnlyStore(fixture);
  const pending = access(fixture.file, fixture.binary);
  expect(pending).rejects.toThrow(
    `Claude refreshed the saved login but could not update ${fixture.file}; Sevro retained the refreshed login at ${record} and restores it on the next run once the store is writable`,
  );
  await pending.catch(() => undefined);
  expect((await storedOAuth(canonical)).refreshToken).toBe(
    "PRIVATE_TEST_REFRESH",
  );
  // The retained record is private and holds only the rotated token fields.
  expect((await stat(record)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
    format: "sevro.claude-login-recovery.v1",
    replaces: createHash("sha256").update("PRIVATE_TEST_REFRESH").digest("hex"),
    oauth: {
      accessToken: "ROTATED_ACCESS_1",
      refreshToken: "ROTATED_REFRESH_1",
      expiresAt: expect.any(Number) as unknown,
      scopes: ["user:inference", "user:profile"],
    },
  });
  await chmod(store, 0o700);
  expect(await access(fixture.file, fixture.binary)).toBe("ROTATED_ACCESS_1");
  expect(await storedOAuth(canonical)).toMatchObject({
    refreshToken: "ROTATED_REFRESH_1",
    subscriptionType: "max",
  });
  // Recovery replaced the consumed token without a second exchange.
  expect(await ledgerLines(fixture.ledger, "requests")).toHaveLength(1);
  expect(stat(record)).rejects.toThrow();
});

test("a pending rotation never overwrites a newer operator login", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  const record = await recoveryRecord(fixture.file);
  recoveryRecords.push(record);
  const { store, canonical } = await readOnlyStore(fixture);
  const pending = access(fixture.file, fixture.binary);
  expect(pending).rejects.toThrow(/retained/);
  await pending.catch(() => undefined);
  await chmod(store, 0o700);
  await writeFile(
    canonical,
    syntheticClaudeLogin({
      accessToken: "OPERATOR_ACCESS",
      refreshToken: "OPERATOR_REFRESH",
    }),
  );
  expect(await access(fixture.file, fixture.binary)).toBe("OPERATOR_ACCESS");
  expect(stat(record)).rejects.toThrow();
  expect(await access(fixture.file, fixture.binary)).toBe("OPERATOR_ACCESS");
  expect((await storedOAuth(canonical)).refreshToken).toBe("OPERATOR_REFRESH");
  expect(await ledgerLines(fixture.ledger, "requests")).toHaveLength(1);
});

test("a login replaced during refresh keeps the operator's newer login", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  recoveryRecords.push(await recoveryRecord(fixture.file));
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
  const pending = access(fixture.file, fixture.binary);
  expect(pending).rejects.toThrow(
    /could not refresh the saved login \(helper exit 1\); run claude and \/login/,
  );
  await pending.catch(() => undefined);
  expect((await storedOAuth(fixture.file)).refreshToken).toBe(
    "PRIVATE_TEST_REFRESH",
  );
  expect(stat(await recoveryRecord(fixture.file))).rejects.toThrow();
});

test.each(["2.1.284", "2.2.0", "3.0.0"])(
  "Claude %s can refresh a due login",
  async (version) => {
    const fixture = await refreshFixture(
      syntheticClaudeLogin({ expiresInMs: -60_000 }),
      { SEVRO_TEST_CLAUDE_VERSION: version },
    );
    recoveryRecords.push(await recoveryRecord(fixture.file));
    expect(await access(fixture.file, fixture.binary)).toBe("ROTATED_ACCESS_1");
    expect(await ledgerLines(fixture.ledger, "requests")).toHaveLength(1);
  },
);

test.each(["2.1.283", "1.9.999", "2.1", "unknown"])(
  "Claude %s, before refresh-token login, cannot refresh",
  async (version) => {
    const fixture = await refreshFixture(
      syntheticClaudeLogin({ expiresInMs: -60_000 }),
      { SEVRO_TEST_CLAUDE_VERSION: version },
    );
    const pending = access(fixture.file, fixture.binary);
    expect(pending).rejects.toThrow(/requires Claude Code 2\.1\.284 or later/);
    await pending.catch(() => undefined);
    expect(await ledgerLines(fixture.ledger, "requests")).toEqual([]);
    expect((await storedOAuth(fixture.file)).refreshToken).toBe(
      "PRIVATE_TEST_REFRESH",
    );
  },
);

test("a login is refreshed when it cannot cover the whole execution budget", async () => {
  const outside = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: 40 * 60_000 }),
  );
  recoveryRecords.push(await recoveryRecord(outside.file));
  expect(await access(outside.file, outside.binary)).toBe("PRIVATE_TEST_LOGIN");
  expect(await access(outside.file, outside.binary, 45 * 60_000)).toBe(
    "ROTATED_ACCESS_1",
  );
  const short = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
    { SEVRO_TEST_OAUTH_LIFETIME_MS: "60000" },
  );
  recoveryRecords.push(await recoveryRecord(short.file));
  const pending = access(short.file, short.binary);
  expect(pending).rejects.toThrow(
    /cannot cover the 30-minute execution budget/,
  );
  await pending.catch(() => undefined);
  // The short rotation is still persisted rather than lost.
  expect((await storedOAuth(short.file)).refreshToken).toBe(
    "ROTATED_REFRESH_1",
  );
});

test("expired logins without refresh authority ask for a new login", async () => {
  for (const login of [
    syntheticClaudeLogin({ expiresInMs: -60_000, refreshToken: null }),
    syntheticClaudeLogin({ expiresInMs: -60_000, refreshToken: "   " }),
    syntheticClaudeLogin({ expiresInMs: -60_000, scopes: [] }),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "PRIVATE_TEST_LOGIN",
        refreshToken: "PRIVATE_TEST_REFRESH",
        expiresAt: Date.now() - 60_000,
        scopes: "user:inference",
      },
    }),
  ]) {
    const fixture = await refreshFixture(login);
    const pending = access(fixture.file, fixture.binary);
    expect(pending).rejects.toThrow(
      /expired and cannot be refreshed; run claude and \/login/,
    );
    await pending.catch(() => undefined);
    expect(await ledgerLines(fixture.ledger, "requests")).toEqual([]);
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

test("a due login waits for a live refresh holder and reuses its login", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  const lock = join(fixture.config, LOCK_NAME);
  await mkdir(lock);
  let settled = false;
  const pending = access(fixture.file, fixture.binary).finally(() => {
    settled = true;
  });
  await Bun.sleep(750);
  expect(settled).toBe(false);
  expect(await ledgerLines(fixture.ledger, "requests")).toEqual([]);
  // The holder refreshed meanwhile; the waiter re-reads under the lock.
  await writeFile(
    fixture.file,
    syntheticClaudeLogin({
      accessToken: "HOLDER_ACCESS",
      refreshToken: "HOLDER_REFRESH",
    }),
  );
  await rmdir(lock);
  expect(await pending).toBe("HOLDER_ACCESS");
  expect(await ledgerLines(fixture.ledger, "requests")).toEqual([]);
  expect(await readdir(fixture.config)).toEqual([".credentials.json"]);
});

test("an abandoned refresh lock is reclaimed and released", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  recoveryRecords.push(await recoveryRecord(fixture.file));
  const lock = join(fixture.config, LOCK_NAME);
  await mkdir(lock);
  const abandoned = new Date(Date.now() - 120_000);
  await utimes(lock, abandoned, abandoned);
  expect(await access(fixture.file, fixture.binary)).toBe("ROTATED_ACCESS_1");
  expect(stat(lock)).rejects.toThrow();
  expect(await ledgerLines(fixture.ledger, "requests")).toHaveLength(1);
});

test("a refresh holder keeps its lock fresh while Claude refreshes", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  recoveryRecords.push(await recoveryRecord(fixture.file));
  // A refresh outlasting Claude Code's 5s lock update interval.
  const binary = join(fixture.root, "slow-claude");
  await writeFile(
    binary,
    `#!/bin/sh\n[ "$1" = auth ] && sleep 7\nexec "${fixture.binary}" "$@"\n`,
  );
  await chmod(binary, 0o700);
  const lock = join(fixture.config, LOCK_NAME);
  const pending = access(fixture.file, binary);
  await Bun.sleep(1_000);
  const acquired = (await stat(lock)).mtimeMs;
  await Bun.sleep(5_000);
  expect((await stat(lock)).mtimeMs).toBeGreaterThan(acquired);
  expect(await pending).toBe("ROTATED_ACCESS_1");
  expect(stat(lock)).rejects.toThrow();
}, 20_000);

test("an unavailable refresh lock refuses refresh", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  await chmod(fixture.config, 0o500);
  try {
    const pending = access(fixture.file, fixture.binary);
    expect(pending).rejects.toThrow(/refresh lock is unavailable/);
    await pending.catch(() => undefined);
  } finally {
    await chmod(fixture.config, 0o700);
  }
  expect(await ledgerLines(fixture.ledger, "requests")).toEqual([]);
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

/** Claude's Keychain item name for the fixture's configuration directory. */
function keychainService(config: string): string {
  return `Claude Code-credentials-${createHash("sha256").update(config).digest("hex").slice(0, 8)}`;
}

test("macOS Keychain logins are refreshed in their own item", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await refreshFixture(syntheticClaudeLogin());
  await rm(fixture.file);
  recoveryRecords.push(
    await recoveryRecord(
      `macOS Keychain item "${keychainService(fixture.config)}"`,
    ),
  );
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
    expect(expectedClaudeKeychainService()).toBe(
      keychainService(fixture.config),
    );
    expect(await access(undefined, fixture.binary)).toBe("ROTATED_ACCESS_1");
  });
  expect(await storedOAuth(item)).toMatchObject({
    refreshToken: "ROTATED_REFRESH_1",
    subscriptionType: "max",
  });
  expect(await readFile(item, "utf8")).toContain("x".repeat(3_000));
  expect(await readdir(fixture.config)).toEqual([]);
});

test("a small Keychain login is updated through security's standard input", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await refreshFixture(syntheticClaudeLogin());
  await rm(fixture.file);
  recoveryRecords.push(
    await recoveryRecord(
      `macOS Keychain item "${keychainService(fixture.config)}"`,
    ),
  );
  const item = join(fixture.root, "keychain-item");
  await writeFile(item, syntheticClaudeLogin({ expiresInMs: -60_000 }));
  await withKeychainLogin(fixture, "expired", async () => {
    expect(await access(undefined, fixture.binary)).toBe("ROTATED_ACCESS_1");
  });
  expect((await storedOAuth(item)).refreshToken).toBe("ROTATED_REFRESH_1");
});

test("an unwritable Keychain item retains the rotation for the next run", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await refreshFixture(syntheticClaudeLogin());
  await rm(fixture.file);
  const service = keychainService(fixture.config);
  const record = await recoveryRecord(`macOS Keychain item "${service}"`);
  recoveryRecords.push(record);
  const item = join(fixture.root, "keychain-item");
  await withKeychainLogin(fixture, "expired-readonly", async () => {
    const pending = access(undefined, fixture.binary);
    expect(pending).rejects.toThrow(
      `could not update macOS Keychain item "${service}"; Sevro retained the refreshed login at ${record}`,
    );
    await pending.catch(() => undefined);
  });
  expect(stat(item)).rejects.toThrow();
  expect((await stat(record)).mode & 0o777).toBe(0o600);
  await withKeychainLogin(fixture, "expired", async () => {
    expect(await access(undefined, fixture.binary)).toBe("ROTATED_ACCESS_1");
  });
  expect((await storedOAuth(item)).refreshToken).toBe("ROTATED_REFRESH_1");
  expect(await ledgerLines(fixture.ledger, "requests")).toHaveLength(1);
  expect(stat(record)).rejects.toThrow();
});

test("Keychain read failures fall back only to an existing saved file", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await refreshFixture(syntheticClaudeLogin());
  await withKeychainLogin(fixture, "failure", async () => {
    expect(await access(undefined, fixture.binary)).toBe("PRIVATE_TEST_LOGIN");
  });
  await withKeychainLogin(fixture, "missing", async () => {
    expect(await access(undefined, fixture.binary)).toBe("PRIVATE_TEST_LOGIN");
  });
  await rm(fixture.file);
  await withKeychainLogin(fixture, "missing", async () => {
    const pending = access(undefined, fixture.binary);
    expect(pending).rejects.toThrow(
      /saved login is unavailable; run claude and \/login/,
    );
    await pending.catch(() => undefined);
  });
  await withKeychainLogin(fixture, "failure", async () => {
    const pending = access(undefined, fixture.binary);
    expect(pending).rejects.toThrow(/credential is unreadable or unavailable/);
    await pending.catch(() => undefined);
  });
});

test("an oversized helper login is not accepted as a rotation", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
    { SEVRO_TEST_OAUTH_MODE: "oversized" },
  );
  const pending = access(fixture.file, fixture.binary);
  expect(pending).rejects.toThrow(
    /could not refresh the saved login \(helper exit 0\)/,
  );
  await pending.catch(() => undefined);
  expect((await storedOAuth(fixture.file)).refreshToken).toBe(
    "PRIVATE_TEST_REFRESH",
  );
});

test("the refresh helper receives the operator's network settings only", async () => {
  const fixture = await refreshFixture(
    syntheticClaudeLogin({ expiresInMs: -60_000 }),
  );
  recoveryRecords.push(await recoveryRecord(fixture.file));
  await withAuthenticationEnvironment(
    { NO_PROXY: "synthetic.invalid", SEVRO_UNRELATED: "unrelated" },
    async () => {
      expect(await access(fixture.file, fixture.binary)).toBe(
        "ROTATED_ACCESS_1",
      );
    },
  );
  // NO_PROXY stands in for every forwarded network setting; unlike a proxy
  // URL, it cannot break later tests' network access if inherited.
  expect(await ledgerLines(fixture.ledger, "proxy")).toEqual([
    "synthetic.invalid",
  ]);
});

test("a Keychain update that is not applied fails persistence verification", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await refreshFixture(syntheticClaudeLogin());
  await rm(fixture.file);
  const service = keychainService(fixture.config);
  const record = await recoveryRecord(`macOS Keychain item "${service}"`);
  recoveryRecords.push(record);
  await withKeychainLogin(fixture, "expired-ignored", async () => {
    const pending = access(undefined, fixture.binary);
    expect(pending).rejects.toThrow(
      `could not update macOS Keychain item "${service}"; Sevro retained the refreshed login at ${record}`,
    );
    await pending.catch(() => undefined);
  });
  expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({
    oauth: { refreshToken: "ROTATED_REFRESH_1" },
  });
});
