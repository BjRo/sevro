#!/usr/bin/env bun
// Synthetic Claude Code CLI for parent-owned refresh tests. It implements only
// `--version` and refresh-token `auth login`, against a local single-use token
// ledger. No Anthropic endpoint or operator credential is involved.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const ledger = process.env.SEVRO_TEST_OAUTH_LEDGER;
const mode = process.env.SEVRO_TEST_OAUTH_MODE ?? "rotate";

if (args[0] === "--version") {
  process.stdout.write(
    `${process.env.SEVRO_TEST_CLAUDE_VERSION ?? "2.1.309"} (Claude Code)\n`,
  );
  process.exit(0);
}
if (args[0] !== "auth" || args[1] !== "login" || !ledger)
  throw new Error("unexpected synthetic Claude invocation");

const refreshToken = process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN ?? "";
const scopes = (process.env.CLAUDE_CODE_OAUTH_SCOPES ?? "").split(" ");
const config = process.env.CLAUDE_CONFIG_DIR ?? "";
const consumed = join(ledger, "consumed");
const used = existsSync(consumed)
  ? readFileSync(consumed, "utf8").split("\n")
  : [];
appendFileSync(join(ledger, "requests"), `${refreshToken}\n`);
// The helper must not reach the operator's Keychain.
const security = Bun.spawnSync(["security", "find-generic-password"]);
appendFileSync(join(ledger, "security"), `${String(security.exitCode)}\n`);
if (!refreshToken || used.includes(refreshToken) || !scopes.length) {
  process.stderr.write("invalid_grant\n");
  process.exit(1);
}
appendFileSync(consumed, `${refreshToken}\n`);
const issued = used.filter(Boolean).length + 1;
if (mode === "relogin" && process.env.SEVRO_TEST_CANONICAL)
  writeFileSync(
    process.env.SEVRO_TEST_CANONICAL,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "OPERATOR_RELOGIN_ACCESS",
        refreshToken: "OPERATOR_RELOGIN_REFRESH",
        expiresAt: Date.now() + 3_600_000,
        scopes,
      },
    }),
  );
appendFileSync(join(ledger, "proxy"), `${process.env.NO_PROXY ?? ""}\n`);
if (mode === "consume-only") process.exit(1);
if (mode === "oversized")
  writeFileSync(join(config, ".credentials.json"), "x".repeat(1024 * 1024 + 1));
if (mode === "oversized") process.exit(0);
if (mode === "slow") await Bun.sleep(1_000);
writeFileSync(
  join(config, ".credentials.json"),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `ROTATED_ACCESS_${String(issued)}`,
      refreshToken: `ROTATED_REFRESH_${String(issued)}`,
      expiresAt:
        Date.now() +
        Number(process.env.SEVRO_TEST_OAUTH_LIFETIME_MS ?? 28_800_000),
      scopes,
      subscriptionType: "helper-should-not-overwrite",
    },
  }),
  { mode: 0o600 },
);
process.stdout.write("Login successful.\n");
