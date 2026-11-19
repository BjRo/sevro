import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageClaudeAuthentication } from "../../../src/claude-login/index";
import { isRecord } from "../../../src/kernel/index";
import { nativeStateParent } from "../../../src/runtime/index";
import { syntheticClaudeLogin } from "../../fixtures/claude-login";
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

const recoveryRecords: string[] = [];
afterEach(async () => {
  await Promise.all(
    recoveryRecords.splice(0).map((path) => rm(path, { force: true })),
  );
});

/** No refresh is due in these scenarios; any helper launch fails. */
const NO_REFRESH = "/nonexistent/claude";

async function temporaryRoot(): Promise<string> {
  return temporaryFixture(join(tmpdir(), "sevro-claude-store-"));
}

/** Stage one trial's authentication and return the only credential it gets. */
async function access(
  file: string | undefined,
  lifetimeMs = 60_000,
): Promise<string | undefined> {
  const root = await temporaryRoot();
  const staged = await stageClaudeAuthentication(join(root, "config"), file, {
    binary: NO_REFRESH,
    lifetimeMs,
  });
  expect(Object.keys(staged.environment)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  return staged.environment.CLAUDE_CODE_OAUTH_TOKEN;
}

/** The private recovery slot Sevro keeps for one store origin. */
async function recoveryRecord(origin: string): Promise<string> {
  const key = createHash("sha256").update(origin).digest("hex");
  const root = join(await nativeStateParent(), "claude-login-recovery");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${key}.json`);
  recoveryRecords.push(path);
  return path;
}

async function storedOAuth(file: string): Promise<Record<string, unknown>> {
  const document: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(document) || !isRecord(document.claudeAiOauth))
    throw new Error("missing stored login");
  return document.claudeAiOauth;
}

/** A configuration directory whose saved file holds a fresh login. */
async function savedLogin(login = syntheticClaudeLogin()) {
  const config = await temporaryRoot();
  const file = join(config, ".credentials.json");
  await writeFile(file, login, { mode: 0o600 });
  return { config, file };
}

test("Claude names its Keychain item after a selected configuration only", async () => {
  await withAuthenticationEnvironment({ CLAUDE_CONFIG_DIR: undefined }, () => {
    expect(expectedClaudeKeychainService()).toBe("Claude Code-credentials");
  });
  // Observed with Claude Code 2.1.309: the first eight hex digits of the
  // directory's SHA-256 name the item.
  await withAuthenticationEnvironment(
    { CLAUDE_CONFIG_DIR: "/synthetic/claude-config" },
    () => {
      expect(expectedClaudeKeychainService()).toBe(
        `Claude Code-credentials-${createHash("sha256").update("/synthetic/claude-config").digest("hex").slice(0, 8)}`,
      );
    },
  );
});

test("the default configuration reads the unsuffixed Keychain item", async () => {
  if (process.platform !== "darwin") return;
  const root = await temporaryRoot();
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  await Promise.all([mkdir(home), mkdir(temporary)]);
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined) environment[name] = value;
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "SEVRO_QUALITY_SECURITY_PID",
    "SEVRO_QUALITY_SECURITY_STORE",
  ])
    Reflect.deleteProperty(environment, name);
  // The synthetic Keychain refuses any item other than the unsuffixed one.
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../fixtures/claude-keychain-stage.ts"),
      "success",
      "quality-account",
    ],
    {
      env: {
        ...environment,
        HOME: home,
        TMPDIR: temporary,
        USER: "quality-account",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: "PRIVATE_TEST_LOGIN",
  });
});

test("a selected configuration reads its own suffixed Keychain item", async () => {
  if (process.platform !== "darwin") return;
  const config = await temporaryRoot();
  await withAuthenticationEnvironment(
    {
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CONFIG_DIR: config,
      USER: "quality-account",
      SEVRO_QUALITY_SECURITY_STORE: undefined,
    },
    async () => {
      expect(expectedClaudeKeychainService()).toMatch(
        /^Claude Code-credentials-[0-9a-f]{8}$/,
      );
      await withSyntheticKeychain("success", true, async () => {
        expect(await access(undefined)).toBe("PRIVATE_TEST_LOGIN");
      });
    },
  );
});

test.each([
  ["quality.account-1", "quality.account-1"],
  ["not valid!", "claude-code-user"],
])(
  "the Keychain account for USER=%s follows Claude Code's normalization",
  async (user, account) => {
    if (process.platform !== "darwin") return;
    const config = await temporaryRoot();
    await withAuthenticationEnvironment(
      {
        ANTHROPIC_API_KEY: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CONFIG_DIR: config,
        USER: user,
        SEVRO_QUALITY_SECURITY_STORE: undefined,
      },
      async () => {
        // The synthetic Keychain refuses every other account, and without a
        // saved file a refused lookup cannot fall back to another login.
        await withSyntheticKeychain("success", account, async () => {
          expect(await access(undefined)).toBe("PRIVATE_TEST_LOGIN");
        });
      },
    );
  },
);

test("a Keychain item that disappears after selection is unreadable", async () => {
  if (process.platform !== "darwin") return;
  const config = await temporaryRoot();
  let lookups = 0;
  await withAuthenticationEnvironment(
    {
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CONFIG_DIR: config,
      USER: "quality-account",
      SEVRO_QUALITY_SECURITY_STORE: undefined,
    },
    async () => {
      await withSyntheticKeychain(
        () => (lookups++ === 0 ? "success" : "missing"),
        true,
        async () => {
          const pending = access(undefined);
          expect(pending).rejects.toThrow(
            /^Claude credential is unreadable or unavailable$/,
          );
          await pending.catch(() => undefined);
        },
      );
    },
  );
  expect(lookups).toBe(2);
});

test("stored logins tolerate absent optional fields", async () => {
  const { file } = await savedLogin(
    JSON.stringify({
      claudeAiOauth: { accessToken: "A", expiresAt: "soon", scopes: "x" },
    }),
  );
  // Without a recorded expiry the login covers any execution budget.
  expect(await access(file, Number.MAX_SAFE_INTEGER)).toBe("A");
});

test("unreadable recovery records are ignored rather than applied", async () => {
  const { file } = await savedLogin();
  const record = await recoveryRecord(file);
  const applicable = {
    format: "sevro.claude-login-recovery.v1",
    replaces: createHash("sha256").update("PRIVATE_TEST_REFRESH").digest("hex"),
    oauth: {
      accessToken: "RECOVERED_ACCESS",
      refreshToken: "RECOVERED_REFRESH",
      expiresAt: Date.now() + 3_600_000,
    },
  };
  expect(await access(file)).toBe("PRIVATE_TEST_LOGIN");
  for (const text of [
    "not-json",
    "[]",
    JSON.stringify({ ...applicable, format: "other" }),
    JSON.stringify({ ...applicable, replaces: 1 }),
    JSON.stringify({ ...applicable, oauth: "RECOVERED_ACCESS" }),
  ]) {
    await writeFile(record, text);
    expect(await access(file)).toBe("PRIVATE_TEST_LOGIN");
    expect((await storedOAuth(file)).refreshToken).toBe("PRIVATE_TEST_REFRESH");
  }
  // A readable record for the stored login completes its rotation once.
  await writeFile(record, JSON.stringify(applicable));
  expect(await access(file)).toBe("RECOVERED_ACCESS");
  expect(await storedOAuth(file)).toMatchObject({
    accessToken: "RECOVERED_ACCESS",
    refreshToken: "RECOVERED_REFRESH",
    subscriptionType: "max",
  });
  expect(stat(record)).rejects.toThrow();
  expect(await access(file)).toBe("RECOVERED_ACCESS");
});

test("a recovery record for another login is discarded unapplied", async () => {
  const { file } = await savedLogin();
  const record = await recoveryRecord(file);
  await writeFile(
    record,
    JSON.stringify({
      format: "sevro.claude-login-recovery.v1",
      replaces: createHash("sha256").update("OTHER_REFRESH").digest("hex"),
      oauth: { accessToken: "RECOVERED_ACCESS" },
    }),
  );
  expect(await access(file)).toBe("PRIVATE_TEST_LOGIN");
  expect((await storedOAuth(file)).accessToken).toBe("PRIVATE_TEST_LOGIN");
  expect(stat(record)).rejects.toThrow();
});

test("without a Keychain item the configuration's saved file is the store", async () => {
  const { config, file } = await savedLogin();
  const environment = {
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CONFIG_DIR: config,
    USER: "quality-account",
  };
  await withAuthenticationEnvironment(environment, () =>
    withSyntheticKeychain("missing", true, async () => {
      expect(await access(undefined)).toBe("PRIVATE_TEST_LOGIN");
    }),
  );
  // A due login refreshes under the configuration directory's lock.
  await writeFile(file, syntheticClaudeLogin({ expiresInMs: -60_000 }));
  await chmod(config, 0o500);
  try {
    await withAuthenticationEnvironment(environment, () =>
      withSyntheticKeychain("missing", true, async () => {
        const pending = access(undefined);
        expect(pending).rejects.toThrow(/refresh lock is unavailable/);
        await pending.catch(() => undefined);
      }),
    );
  } finally {
    await chmod(config, 0o700);
  }
});
