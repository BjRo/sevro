import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment, runGit } from "../../src/git";
import { gitHeadRevision } from "../../src/graders/git-head";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

async function repository(): Promise<string> {
  const cwd = await temporaryFixture(join(tmpdir(), "sevro-shared-git-"));

  await git(cwd, ["init", "--quiet", "--initial-branch=main"]);
  return cwd;
}

function git(cwd: string, args: string[], input?: Uint8Array) {
  return runGit({
    cwd,
    args,
    input,
    identity: "fixture",
    label: "test fixture",
    maxOutputBytes: 1024,
  });
}

test("Git environment drops ambient selectors, credentials and injected config", () => {
  const injected = {
    GIT_DIR: "/other/.git",
    GIT_WORK_TREE: "/other",
    GIT_INDEX_FILE: "/other/index",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/other/hooks",
    GIT_AUTHOR_NAME: "Ambient author",
    GIT_TEMPLATE_DIR: "/other/template",
    NODE_OPTIONS: "--require=/other/injection",
    HOME: "/other/home",
    SystemRoot: "/system",
  };
  const original = new Map(
    Object.keys(injected).map((key) => [key, process.env[key]]),
  );
  const path = process.env.PATH;
  try {
    Object.assign(process.env, injected);
    delete process.env.PATH;
    const environment = gitEnvironment();
    expect(environment.PATH).toBe("/usr/bin:/bin");
    expect(environment.SystemRoot).toBe("/system");
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(environment.GIT_NO_REPLACE_OBJECTS).toBe("1");
    for (const key of Object.keys(injected).filter(
      (key) => key !== "SystemRoot",
    ))
      expect(Object.hasOwn(environment, key)).toBe(false);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});

test.each(["fixture", "advisory"] as const)(
  "Git commits use the deterministic %s identity and suppress configured hooks",
  async (identity) => {
    const cwd = await repository();
    const hooks = join(cwd, "hooks");
    await mkdir(hooks);
    const hook = join(hooks, "pre-commit");
    await writeFile(hook, "#!/bin/sh\nprintf hooked > hook-ran\nexit 99\n");
    await chmod(hook, 0o700);
    await git(cwd, ["config", "core.hooksPath", hooks]);
    await writeFile(join(cwd, "data"), "fixture\n");
    await git(cwd, ["add", "data"]);
    await runGit({
      cwd,
      args: ["commit", "--quiet", "-m", "Fixture baseline"],
      identity,
      label: "test fixture",
      maxOutputBytes: 1024,
    });
    const author = await git(cwd, [
      "show",
      "-s",
      "--format=%an <%ae>|%cn <%ce>|%at|%ct",
      "HEAD",
    ]);
    const name = identity === "fixture" ? "Sevro Fixture" : "Sevro Advisory";
    expect(author.toString()).toBe(
      `${name} <${identity}@sevro.invalid>|${name} <${identity}@sevro.invalid>|946684800|946684800\n`,
    );
    expect(await gitHeadRevision(cwd)).toMatch(/^[a-f0-9]{40,64}$/);
    expect(readFile(join(cwd, "hook-ran"))).rejects.toThrow();
  },
);

test("Git transports binary stdin and stdout without decoding patches", async () => {
  const cwd = await repository();
  const bytes = Buffer.from([0, 0xff, 0xfe, 0x0a, 0x42]);
  const hash = (await git(cwd, ["hash-object", "-w", "--stdin"], bytes))
    .toString()
    .trim();
  expect(await git(cwd, ["cat-file", "blob", hash])).toEqual(bytes);
  expect(
    runGit({
      cwd,
      args: ["cat-file", "blob", hash],
      identity: "fixture",
      label: "test fixture",
      maxOutputBytes: 1024,
      validateUtf8: true,
    }),
  ).rejects.toThrow();
});

test("Git enforces the exact output bound independently on stdout and stderr", async () => {
  const cwd = await repository();
  const options = {
    cwd,
    identity: "fixture" as const,
    label: "test fixture",
    maxOutputBytes: 6,
  };
  expect(
    (
      await runGit({
        ...options,
        args: ["-c", "alias.output=!printf abcdef", "output"],
      })
    ).toString(),
  ).toBe("abcdef");
  for (const stream of ["", " >&2"])
    expect(
      runGit({
        ...options,
        args: ["-c", `alias.output=!printf abcdefg${stream}`, "output"],
      }),
    ).rejects.toThrow("test fixture Git output is too large");
  expect(
    runGit({
      ...options,
      maxOutputBytes: 1024,
      validateUtf8: true,
      args: ["-c", "alias.output=!printf '\\377' >&2", "output"],
    }),
  ).rejects.toThrow();
});

test("Git reports a failed command without accepting its partial stdout", async () => {
  const cwd = await repository();
  expect(
    git(cwd, ["-c", "alias.failure=!printf partial; exit 7", "failure"]),
  ).rejects.toThrow("test fixture Git operation failed");
});
