import { spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import { isStringArray } from "../../src/kernel/index";

export async function withAuthenticationEnvironment<T>(
  values: Record<string, string | undefined>,
  action: () => T | Promise<T>,
): Promise<T> {
  const original = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values))
    assignEnvironment(key, value);
  try {
    return await action();
  } finally {
    for (const [key, value] of original) assignEnvironment(key, value);
  }
}
function assignEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}
/**
 * The Keychain item Claude Code uses: a selected configuration directory names
 * its own item by the first eight hex digits of the path's SHA-256 (observed
 * with Claude Code 2.1.309).
 */
export function expectedClaudeKeychainService(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (!configured) return "Claude Code-credentials";
  const digest = createHash("sha256")
    .update(configured.normalize("NFC"))
    .digest("hex");
  return `Claude Code-credentials-${digest.slice(0, 8)}`;
}
/** The synthetic account, the invoking user, or an exact expected account. */
type SyntheticAccount = boolean | string;
/** One mode for every invocation, or a mode chosen per invocation. */
type SyntheticMode = string | (() => string);
function substitutedSecurityCommand(
  command: string[],
  mode: SyntheticMode,
  account: SyntheticAccount,
): string[] {
  if (command[0] !== "/usr/bin/security") return command;
  if (!expectedKeychainCommand(command, account))
    throw new Error(
      "Unexpected security invocation; real keychain access refused",
    );
  return [
    process.execPath,
    join(import.meta.dir, "host-security.ts"),
    currentMode(mode),
    process.env.SEVRO_QUALITY_SECURITY_PID ?? "",
    process.env.SEVRO_QUALITY_SECURITY_STORE ?? "",
    ...command.slice(1),
  ];
}
function currentMode(mode: SyntheticMode): string {
  return typeof mode === "string" ? mode : mode();
}
/** Only Claude's own item for the synthetic account may be addressed. */
function expectedKeychainCommand(command: string[], account: SyntheticAccount) {
  if (JSON.stringify(command) === '["/usr/bin/security","-i"]') return true;
  return (
    command[command.indexOf("-a") + 1] === expectedAccount(account) &&
    command[command.indexOf("-s") + 1] === expectedClaudeKeychainService()
  );
}
function expectedAccount(account: SyntheticAccount): string {
  if (typeof account === "string") return account;
  return account ? "quality-account" : userInfo().username;
}
// Only the external keychain command is replaced. The authentication reader,
// real substituted subprocess, host invocation, and all other spawns run intact.
export async function withSyntheticKeychain<T>(
  mode: SyntheticMode,
  account: SyntheticAccount,
  action: () => T | Promise<T>,
): Promise<T> {
  const originalSpawn = Bun.spawn;
  function intercept<
    const In extends Bun.Spawn.Writable = "ignore",
    const Out extends Bun.Spawn.Readable = "pipe",
    const Err extends Bun.Spawn.Readable = "inherit",
  >(
    command:
      string[] | (Bun.Spawn.BaseOptions<In, Out, Err> & { cmd: string[] }),
    options?: Bun.Spawn.BaseOptions<In, Out, Err>,
  ): Bun.Subprocess<In, Out, Err> {
    if (isStringArray(command))
      return originalSpawn(
        substitutedSecurityCommand(command, mode, account),
        options,
      );
    return originalSpawn({
      ...command,
      cmd: substitutedSecurityCommand(command.cmd, mode, account),
    });
  }
  const replacement = spyOn(Bun, "spawn").mockImplementation(intercept);
  try {
    return await action();
  } finally {
    replacement.mockRestore();
  }
}
