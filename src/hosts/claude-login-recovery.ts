import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../value-guards";
import { rotatedOAuth, tokenDigest, type ClaudeLogin } from "./claude-login";

const FORMAT = "sevro.claude-login-recovery.v1";

/** A rotated pair retained until its canonical store verifiably holds it. */
export interface PendingRotation {
  /** Digest of the refresh token the rotation consumed. */
  replaces: string;
  oauth: Record<string, unknown>;
}

/** Private, per-origin recovery slot for one refreshed login. */
export class ClaudeLoginRecovery {
  readonly path: string;
  readonly workRoot: string;

  constructor(root: string, origin: string) {
    const key = createHash("sha256").update(origin).digest("hex");
    this.path = join(root, `${key}.json`);
    this.workRoot = join(root, "work");
  }

  async pending(): Promise<PendingRotation | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return undefined;
    }
    return pendingRotation(text);
  }

  /** Durably retain the rotation before any canonical write is attempted. */
  async retain(replaced: ClaudeLogin, rotated: ClaudeLogin): Promise<void> {
    const record: PendingRotation & { format: string } = {
      format: FORMAT,
      replaces: tokenDigest(replaced.refreshToken),
      oauth: rotatedOAuth(rotated),
    };
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }

  async discard(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

function pendingRotation(text: string): PendingRotation | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isPendingRecord(value)
    ? { replaces: value.replaces, oauth: value.oauth }
    : undefined;
}

function isPendingRecord(value: unknown): value is PendingRotation {
  return (
    isRecord(value) &&
    value.format === FORMAT &&
    typeof value.replaces === "string" &&
    isRecord(value.oauth)
  );
}

export async function claudeLoginRecovery(
  stateRoot: string,
  origin: string,
): Promise<ClaudeLoginRecovery> {
  const root = join(stateRoot, "claude-login-recovery");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return new ClaudeLoginRecovery(root, origin);
}
