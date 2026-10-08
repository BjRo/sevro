import { join, resolve } from "node:path";

export const documentationRoot = resolve(import.meta.dir, "../..");

export async function guideCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(documentationRoot, "scripts/eval-guide.ts"),
      ...args,
    ],
    {
      cwd: documentationRoot,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
