import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("installed Node workflows run without Bun and clean up interrupted shell children", async () => {
  const child = Bun.spawn(
    [process.execPath, "scripts/verify-node-runtime.ts"],
    {
      cwd: resolve(import.meta.dirname, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("Bun absent from PATH");
}, 120_000);
