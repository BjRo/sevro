import { spyOn } from "bun:test";
import { userInfo } from "node:os";
import { join } from "node:path";
import { claudeKeychainService } from "../../src/hosts/claude-login-store";
import { isStringArray } from "../../src/value-guards";

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
function substitutedSecurityCommand(
  command: string[],
  mode: string,
  account: boolean,
): string[] {
  if (command[0] !== "/usr/bin/security") return command;
  if (!expectedKeychainCommand(command, account))
    throw new Error(
      "Unexpected security invocation; real keychain access refused",
    );
  return [
    process.execPath,
    join(import.meta.dir, "host-security.ts"),
    mode,
    process.env.SEVRO_QUALITY_SECURITY_PID ?? "",
    process.env.SEVRO_QUALITY_SECURITY_STORE ?? "",
    ...command.slice(1),
  ];
}
/** Only Claude's own item for the synthetic account may be addressed. */
function expectedKeychainCommand(command: string[], account: boolean) {
  if (JSON.stringify(command) === '["/usr/bin/security","-i"]') return true;
  const expectedAccount = account ? "quality-account" : userInfo().username;
  return (
    command[command.indexOf("-a") + 1] === expectedAccount &&
    command[command.indexOf("-s") + 1] === claudeKeychainService()
  );
}
// Only the external keychain command is replaced. The authentication reader,
// real substituted subprocess, host invocation, and all other spawns run intact.
export async function withSyntheticKeychain<T>(
  mode: string,
  account: boolean,
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
