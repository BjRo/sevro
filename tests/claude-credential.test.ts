import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageClaudeCredential } from "../src/hosts/claude-credential";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Claude login staging copies bounded bytes into a private file", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-credential-"));
  roots.push(root);
  const source = join(root, "source.json");
  const privateRoot = join(root, "private");
  await writeFile(source, '{"test":"credential"}');
  const target = await stageClaudeCredential(privateRoot, source);
  expect(await readFile(target, "utf8")).toBe('{"test":"credential"}');
  expect((await stat(target)).mode & 0o777).toBe(0o600);
  await expect(stageClaudeCredential(privateRoot, source)).rejects.toThrow();
});

test("Claude login staging rejects absent and oversized input", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-credential-"));
  roots.push(root);
  const source = join(root, "source.json");
  await expect(stageClaudeCredential(join(root, "private"), source)).rejects.toThrow(
    /unreadable or unavailable/,
  );
  await writeFile(source, Buffer.alloc(1024 * 1024 + 1));
  await expect(stageClaudeCredential(join(root, "private"), source)).rejects.toThrow(
    /unreadable or unavailable/,
  );
});
