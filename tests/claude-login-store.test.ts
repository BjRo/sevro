import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coversLifetime, parseClaudeLogin } from "../src/hosts/claude-login";
import { claudeLoginRecovery } from "../src/hosts/claude-login-recovery";
import {
  claudeKeychainAccount,
  claudeKeychainService,
  claudeLoginStore,
  type ClaudeKeychain,
} from "../src/hosts/claude-login-store";
import { syntheticClaudeLogin } from "./fixtures/claude-login";
import { withAuthenticationEnvironment } from "./fixtures/host-auth";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-store-"));
  roots.push(root);
  return root;
}

const absentKeychain: ClaudeKeychain = {
  read: () => Promise.resolve(undefined),
  write: () => Promise.reject(new Error("unexpected write")),
};

test("only a selected Claude configuration suffixes its Keychain item", async () => {
  await withAuthenticationEnvironment({ CLAUDE_CONFIG_DIR: undefined }, () => {
    expect(claudeKeychainService()).toBe("Claude Code-credentials");
  });
  // Observed with Claude Code 2.1.309: the first eight hex digits of the
  // directory's SHA-256 name the item.
  await withAuthenticationEnvironment(
    { CLAUDE_CONFIG_DIR: "/synthetic/claude-config" },
    () => {
      expect(claudeKeychainService()).toBe(
        `Claude Code-credentials-${createHash("sha256").update("/synthetic/claude-config").digest("hex").slice(0, 8)}`,
      );
    },
  );
});

test("Keychain accounts follow Claude Code's account normalization", async () => {
  await withAuthenticationEnvironment({ USER: "quality.account-1" }, () => {
    expect(claudeKeychainAccount()).toBe("quality.account-1");
  });
  await withAuthenticationEnvironment({ USER: "not valid!" }, () => {
    expect(claudeKeychainAccount()).toBe("claude-code-user");
  });
});

test("a Keychain item that disappears after selection is unreadable", async () => {
  let reads = 0;
  const vanishing: ClaudeKeychain = {
    read: () =>
      Promise.resolve(
        reads++ === 0 ? Buffer.from(syntheticClaudeLogin()) : undefined,
      ),
    write: () => Promise.resolve(),
  };
  await withAuthenticationEnvironment(
    { CLAUDE_CONFIG_DIR: await temporaryRoot() },
    async () => {
      const store = await claudeLoginStore(undefined, vanishing);
      expect(store.origin).toMatch(/^macOS Keychain item "Claude Code/);
      expect(store.read()).rejects.toThrow(/unreadable or unavailable/);
    },
  );
});

test("stored logins tolerate absent optional fields", () => {
  const login = parseClaudeLogin(
    Buffer.from(
      JSON.stringify({
        claudeAiOauth: { accessToken: "A", expiresAt: "soon", scopes: "x" },
      }),
    ),
  );
  expect(login).toMatchObject({
    refreshToken: undefined,
    expiresAt: undefined,
    scopes: [],
  });
  expect(coversLifetime(login, Number.MAX_SAFE_INTEGER)).toBe(true);
});

test("unreadable recovery records are ignored rather than applied", async () => {
  const root = await temporaryRoot();
  const recovery = await claudeLoginRecovery(root, "synthetic-origin");
  expect(await recovery.pending()).toBeUndefined();
  for (const text of ["not-json", '{"format":"other"}', "[]"]) {
    await writeFile(recovery.path, text);
    expect(await recovery.pending()).toBeUndefined();
  }
  const login = parseClaudeLogin(Buffer.from(syntheticClaudeLogin()));
  await recovery.retain({ ...login, refreshToken: undefined }, login);
  expect(await recovery.pending()).toMatchObject({
    oauth: { accessToken: "PRIVATE_TEST_LOGIN" },
  });
  await recovery.discard();
  expect(await recovery.pending()).toBeUndefined();
});

test("without a Keychain item the configuration's saved file is the store", async () => {
  const config = await temporaryRoot();
  await writeFile(join(config, ".credentials.json"), syntheticClaudeLogin());
  await withAuthenticationEnvironment(
    { CLAUDE_CONFIG_DIR: config },
    async () => {
      for (const keychain of [absentKeychain, undefined]) {
        const store = await claudeLoginStore(undefined, keychain);
        expect(store.origin).toBe(join(config, ".credentials.json"));
        expect(store.lockRoot).toBe(config);
      }
    },
  );
});
