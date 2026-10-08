import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLinuxSandboxCommand } from "../src/hosts/linux-sandbox";

const available = process.platform === "linux" && existsSync("/usr/bin/bwrap");

test.skipIf(!available)("Linux isolation masks protected files and preserves owned runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-linux-sandbox-"));
  const workspace = join(root, "workspace");
  const source = join(root, "source");
  const state = join(root, "private");
  const runtime = join(state, "runtime");
  const tools = join(root, "tools");
  try {
    await Promise.all([workspace, source, runtime, tools].map((path) => mkdir(path, { recursive: true })));
    await Promise.all([
      writeFile(join(source, "secret"), "private"),
      writeFile(join(state, "secret"), "private"),
      writeFile(join(tools, "public"), "readable"),
    ]);
    const isolated = await prepareLinuxSandboxCommand({
      argv: [
        "/bin/sh", "-c",
        'test ! -r "$1/secret" && test ! -r "$2/secret" && test "$(cat "$3/public")" = readable && ! touch "$3/changed" 2>/dev/null && printf owned > "$4/out" && printf workspace > "$5/out"',
        "sevro-probe", source, state, tools, runtime, workspace,
      ],
      workspace,
      protectedRoots: [source],
      privateStateRoot: state,
      readOnlyRoots: [tools],
      writableRuntimeRoot: runtime,
      denyNetwork: true,
    });
    try {
      const child = Bun.spawn(isolated.argv, { cwd: workspace, stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0);
      expect(await readFile(join(runtime, "out"), "utf8")).toBe("owned");
      expect(await readFile(join(workspace, "out"), "utf8")).toBe("workspace");
      expect(await readFile(join(source, "secret"), "utf8")).toBe("private");
    } finally {
      await isolated.release();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!available)("Linux isolation refuses private state inside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-linux-state-"));
  const workspace = join(root, "workspace");
  const source = join(root, "source");
  try {
    await Promise.all([workspace, source].map((path) => mkdir(path)));
    expect(prepareLinuxSandboxCommand({
      argv: ["/bin/true"],
      workspace,
      protectedRoots: [source],
      privateStateRoot: join(workspace, "private"),
    })).rejects.toThrow("sandbox state is inside the candidate workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
