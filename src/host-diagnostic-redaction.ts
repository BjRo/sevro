import { readFile, stat } from "node:fs/promises";
import { isRecord } from "./value-guards";

function credentialStrings(value: unknown): string[] {
  const pending: unknown[] = [value];
  const secrets: string[] = [];
  for (let visited = 0; visited < 256; visited++) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (item.length >= 8) secrets.push(item);
    } else if (isRecord(item)) pending.push(...Object.values(item));
  }
  return secrets;
}

/** Read credentials only for scrubbing; failures belong to the actual host preparation. */
export async function diagnosticSecrets(path: string): Promise<string[]> {
  try {
    if ((await stat(path)).size > 1024 * 1024) return [];
    const text = await readFile(path, "utf8");
    try {
      const value: unknown = JSON.parse(text);
      return credentialStrings(value);
    } catch {
      return text.trim() ? [text.trim()] : [];
    }
  } catch {
    return [];
  }
}

export function redactDiagnosticText(text: string, secrets: string[]): string {
  for (const secret of secrets) {
    text = text.replaceAll(secret, "[redacted]");
    text = redactCredentialSuffix(text, secret);
  }
  return text
    .replace(/(authorization\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)\S+/gi,
      "$1[redacted]",
    );
}

function redactCredentialSuffix(text: string, secret: string): string {
  const start = text.lastIndexOf(secret.slice(0, Math.min(8, secret.length)));
  if (start >= 0 && secret.startsWith(text.slice(start)))
    return text.slice(0, start) + "[redacted]";
  return text;
}
