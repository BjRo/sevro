import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexPermissionProfile } from "../src/hosts/codex-profile";

test("Codex profile denies roots and strips command credentials", () => {
  const profile = codexPermissionProfile({
    id: "sevro_trial",
    workspace: "/tmp/fixture",
    commandHome: "/tmp/fixture/home",
    commandTemp: "/tmp/fixture/tmp",
    executableReadRoots: ["/bin"],
    protectedRoots: ["/source", "/auth"],
  });
  expect(profile).toContain('"/source" = "deny"');
  expect(profile).toContain('"/auth" = "deny"');
  expect(profile).toContain('inherit = "none"');
  expect(profile).toContain('approval_policy = "never"');
  expect(() =>
    codexPermissionProfile({
      id: "bad.id",
      workspace: "/tmp/fixture",
      commandHome: "/tmp/fixture/home",
      commandTemp: "/tmp/fixture/tmp",
      executableReadRoots: ["/bin"],
      protectedRoots: ["/source"],
    }),
  ).toThrow(/profile ID/);
});

test("actual Codex sandbox keeps fixture access and denies source and auth", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const root = await mkdtemp(join(tmpdir(), "sevro-codex-policy-"));
  const fixture = join(root, "fixture");
  const source = join(root, "source");
  const state = join(root, "state");
  const codexHome = join(state, "codex-home");
  const commandHome = join(state, "command-home");
  const commandTemp = join(state, "command-tmp");
  try {
    await Promise.all([mkdir(fixture), mkdir(source), mkdir(state)]);
    await mkdir(codexHome);
    await Promise.all([mkdir(commandHome), mkdir(commandTemp)]);
    await writeFile(join(fixture, "visible.txt"), "visible\n");
    await writeFile(join(source, "hidden.txt"), "hidden\n");
    await writeFile(join(codexHome, "auth.json"), "dummy-auth\n", {
      mode: 0o600,
    });
    await writeFile(
      join(codexHome, "config.toml"),
      codexPermissionProfile({
        id: "sevro_trial",
        workspace: fixture,
        commandHome,
        commandTemp,
        executableReadRoots: [
          dirname(installedCodex),
          dirname(await realpath(installedCodex)),
        ],
        protectedRoots: [source, state],
      }),
      { mode: 0o600 },
    );
    const run = async (argv: string[]) => {
      const proc = Bun.spawn(
        ["codex", "sandbox", "-P", "sevro_trial", "-C", fixture, ...argv],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: root,
            CODEX_HOME: codexHome,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, code };
    };
    expect((await run(["/bin/cat", join(fixture, "visible.txt")])).code).toBe(
      0,
    );
    expect((await run(["/bin/cat", join(source, "hidden.txt")])).code).not.toBe(
      0,
    );
    expect(
      (await run(["/bin/cat", join(codexHome, "auth.json")])).code,
    ).not.toBe(0);
    expect(
      (await run(["/bin/sh", "-c", "printf created > created.txt"])).code,
    ).toBe(0);
    expect(await readFile(join(fixture, "created.txt"), "utf8")).toBe(
      "created",
    );
    expect((await run([installedCodex, "--version"])).code).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
