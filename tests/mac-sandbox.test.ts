import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostIsolationError,
  macSandboxProfile,
  prepareMacSandboxCommand,
} from "../src/hosts/mac-sandbox";

test("profile denies reads and writes of each protected root", () => {
  const profile = macSandboxProfile(["/private/source", "/private/evidence"]);
  expect(profile).toContain('(deny file-read* (subpath "/private/source"))');
  expect(profile).toContain('(deny file-write* (subpath "/private/evidence"))');
  expect(macSandboxProfile(["/private/source"], true)).toContain(
    "(deny network*)",
  );
  expect(() => macSandboxProfile([])).toThrow(HostIsolationError);
  expect(() => macSandboxProfile(["/bad\npath"])).toThrow(/control character/);
});

test("outer sandbox permits the fixture but denies protected source", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "sevro-sandbox-test-"));
  const workspace = join(root, "workspace");
  const source = join(root, "source");
  const state = join(root, "state");
  try {
    await Bun.write(join(workspace, "visible.txt"), "visible");
    await Bun.write(join(source, "secret.txt"), "secret");
    const command = await prepareMacSandboxCommand({
      argv: ["/bin/cat", join(workspace, "visible.txt")],
      workspace,
      protectedRoots: [source],
      privateStateRoot: state,
    });
    const profilePath = command.argv[2]!;
    expect(await readFile(profilePath, "utf8")).toContain(source);
    const allowed = Bun.spawn(command.argv, { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(allowed.stdout).text()).toBe("visible");
    expect(await allowed.exited).toBe(0);
    await command.release();
    const deniedCommand = await prepareMacSandboxCommand({
      argv: ["/bin/cat", join(source, "secret.txt")],
      workspace,
      protectedRoots: [source],
      privateStateRoot: state,
    });
    const denied = Bun.spawn(deniedCommand.argv, {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await denied.exited).not.toBe(0);
    await deniedCommand.release();
    const writeCommand = await prepareMacSandboxCommand({
      argv: ["/bin/mkdir", join(source, "created")],
      workspace,
      protectedRoots: [source],
      privateStateRoot: state,
    });
    const writeAttempt = Bun.spawn(writeCommand.argv, {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await writeAttempt.exited).not.toBe(0);
    await writeCommand.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace cannot overlap a protected root", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "sevro-sandbox-overlap-"));
  try {
    await expect(
      prepareMacSandboxCommand({
        argv: ["/bin/true"],
        workspace: root,
        protectedRoots: [root],
        privateStateRoot: join(root, "state"),
      }),
    ).rejects.toThrow(/candidate workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
