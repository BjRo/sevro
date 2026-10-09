import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const MAX_CREDENTIAL_BYTES = 1024 * 1024;

async function savedClaudeCredential(): Promise<string | undefined> {
  const path = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    ".credentials.json",
  );
  try {
    await stat(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Claude saved credential is unreadable or unavailable", {
      cause: error,
    });
  }
}

export const CLAUDE_AUTH_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** Keep the CLI's authentication separate from the candidate tool environment. */
export async function stageClaudeAuthentication(
  configRoot: string,
  sourceFile?: string,
) {
  const environment = authenticationEnvironment(sourceFile);
  if (Object.keys(environment).length) {
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    return {
      credentialFile: join(configRoot, ".credentials.json"),
      environment,
    };
  }
  return {
    credentialFile: await stageClaudeCredential(configRoot, sourceFile),
    environment,
  };
}

function boundedEnvironmentCredential(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_BYTES)
    throw new Error("Claude environment credential exceeds the size limit");
  return value;
}

function authenticationEnvironment(sourceFile: string | undefined) {
  const environment: Record<string, string> = {};
  if (sourceFile === undefined) {
    for (const name of CLAUDE_AUTH_VARIABLES) {
      const value = process.env[name];
      if (value) {
        environment[name] = boundedEnvironmentCredential(value);
      }
    }
  }
  return environment;
}

/** Copy only a bounded login credential into one private host state. */
export async function stageClaudeCredential(
  configRoot: string,
  sourceFile?: string,
): Promise<string> {
  sourceFile ??= await savedClaudeCredential();
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  let credential: Buffer;
  try {
    credential = await readCredential(sourceFile);
  } catch (error) {
    throw new Error("Claude credential is unreadable or unavailable", {
      cause: error,
    });
  }
  requireBoundedCredential(credential);
  const target = join(configRoot, ".credentials.json");
  await writeFile(target, credential, { flag: "wx", mode: 0o600 });
  return target;
}

async function readCredential(sourceFile: string | undefined) {
  if (!sourceFile) {
    if (process.platform !== "darwin")
      throw new Error("Claude keychain credential is unavailable");
    const { keychainCredential } = await import("./claude-keychain");
    return keychainCredential();
  }
  if ((await stat(sourceFile)).size > MAX_CREDENTIAL_BYTES)
    throw new Error("oversized credential");
  return readFile(sourceFile);
}

function requireBoundedCredential(credential: Buffer): void {
  if (
    credential.byteLength === 0 ||
    credential.byteLength > MAX_CREDENTIAL_BYTES ||
    !credential.toString("utf8").trim()
  )
    throw new Error("Claude credential is empty or oversized");
}
