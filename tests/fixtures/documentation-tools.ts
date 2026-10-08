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
