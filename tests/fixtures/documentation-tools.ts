import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const documentationRoot = resolve(import.meta.dir, "../..");

export async function guideCli(args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(documentationRoot, "scripts/eval-guide.ts"),
      ...args,
    ],
    { cwd: documentationRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

export async function retainedGuideEvidence(
  code: number,
  filesUnchanged: boolean,
  effects: boolean,
) {
  const results = join(documentationRoot, ".guide-results");
  await mkdir(results, { recursive: true });
  const directory = await mkdtemp(join(results, "documentation-test-"));
  const skillDigest = createHash("sha256")
    .update(
      await readFile(
        join(documentationRoot, ".agents/skills/sevro-guide/SKILL.md"),
      ),
    )
    .digest("hex");
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify({ host: "codex", skillDigest }),
  );
  const events = effects
    ? [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "touch side-effect",
            exit_code: 0,
          },
        },
      ]
    : [];
  const original = JSON.stringify({
    first: { answer: "323", code, diagnostic: "", events },
    checks: { filesUnchanged },
  });
  await writeFile(join(directory, "unrelated.json"), original);
  return { directory, original };
}
