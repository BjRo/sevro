import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessShellCheck,
  prepareShellChecks,
  runShellCheck,
} from "../src/graders/shell";

test("shell declarations reject invalid commands and bounds", () => {
  const check = (configuration: Record<string, unknown>) =>
    prepareShellChecks([{ id: "check", grader: "sevro.shell", configuration }]);
  expect(check({ run: "test -f README.md" })[0]).toMatchObject({
    expectedExitCode: 0,
    timeoutMs: 30_000,
  });
  expect(() => check({ run: "" })).toThrow(/bounded command/);
  expect(() => check({ run: "true", timeoutMs: 0 })).toThrow(/timeout/);
  expect(() => check({ run: "true", expectedExitCode: 256 })).toThrow(
    /exit code/,
  );
  expect(() => check({ run: "true", extra: true })).toThrow(/unsupported/);
  expect(() => check({ run: "true", expectRegex: "(" })).toThrow(/regex/);
  expect(() => check({ run: "true", flags: "ii", expectRegex: "ok" })).toThrow(
    /flags/,
  );
  expect(() => check({ run: "true", flags: "i" })).toThrow(/flags/);
});

test("shell stdout assertions preserve exact and multiline matching semantics", () => {
  const [check] = prepareShellChecks([
    {
      id: "check",
      grader: "sevro.shell",
      configuration: {
        run: "printf 'first\\nsecond\\n'",
        expectExact: "first\nsecond",
        expectRegex: "^second$",
        notRegex: "forbidden",
      },
    },
  ]);
  expect(
    assessShellCheck(check!, { exitCode: 0, stdout: "first\nsecond\n" }).passed,
  ).toBeTrue();
  expect(
    assessShellCheck(check!, { exitCode: 0, stdout: "first\nother\n" }).passed,
  ).toBeFalse();
  expect(
    assessShellCheck(check!, { exitCode: 1, stdout: "first\nsecond\n" }).detail,
  ).toContain("exit code");
  const [negative] = prepareShellChecks([
    {
      id: "negative",
      grader: "sevro.shell",
      configuration: {
        run: "true",
        notRegex: "forbidden",
      },
    },
  ]);
  expect(
    assessShellCheck(negative!, { exitCode: 0, stdout: "forbidden\n" }).passed,
  ).toBeFalse();
});

test("timed out shell checks stop without returning a result", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "sevro-shell-timeout-"));
  const workspace = join(root, "fixture");
  try {
    await Bun.write(join(workspace, "README.md"), "fixture\n");
    const [check] = prepareShellChecks([
      {
        id: "slow",
        grader: "sevro.shell",
        configuration: { run: "sleep 10", timeoutMs: 50 },
      },
    ]);
    await expect(
      runShellCheck(check!, {
        workspace,
        protectedRoots: [join(import.meta.dir, "..", "src")],
        privateStateRoot: join(root, "private"),
      }),
    ).rejects.toThrow(/timed out/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated shell checks can use an explicit toolchain", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "sevro-shell-toolchain-"));
  const workspace = join(root, "fixture");
  const toolchainBinDir = join(root, "toolchain");
  try {
    await Promise.all([workspace, toolchainBinDir].map((path) => mkdir(path)));
    await mkdir(join(workspace, ".git", "sevro-runtime", "uv-cache"), {
      recursive: true,
    });
    const tool = join(toolchainBinDir, "sevro-tool");
    await writeFile(tool, "#!/bin/sh\nprintf 'ready\\n'\n");
    await chmod(tool, 0o755);
    const [check] = prepareShellChecks([
      {
        id: "toolchain",
        grader: "sevro.shell",
        configuration: {
          run: 'test -d "$UV_CACHE_DIR" && test "$UV_OFFLINE" = 1 && sevro-tool',
          expectExact: "ready",
        },
      },
    ]);
    const result = await runShellCheck(check!, {
      workspace,
      toolchainBinDir,
      uvRuntimeCache: true,
      protectedRoots: [join(import.meta.dir, "..", "src")],
      privateStateRoot: join(root, "private"),
    });
    expect(result.exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell check sees the fixture but cannot read or write protected sources", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "sevro-shell-check-"));
  const workspace = join(root, "fixture");
  const protectedRoot = join(root, "source");
  try {
    await Bun.write(join(workspace, "README.md"), "visible\n");
    await Bun.write(join(protectedRoot, "secret.txt"), "hidden\n");
    const run = async (command: string) => {
      const [check] = prepareShellChecks([
        { id: "check", grader: "sevro.shell", configuration: { run: command } },
      ]);
      return runShellCheck(check!, {
        workspace,
        protectedRoots: [protectedRoot],
        privateStateRoot: join(root, "private"),
      });
    };
    expect((await run("test -f README.md")).exitCode).toBe(0);
    expect(
      (await run(`cat '${join(protectedRoot, "secret.txt")}' >/dev/null`))
        .exitCode,
    ).not.toBe(0);
    expect(
      (await run(`mkdir '${join(protectedRoot, "new")}'`)).exitCode,
    ).not.toBe(0);
    expect(
      (await run('test -z "$OPENAI_API_KEY$ANTHROPIC_API_KEY$GH_TOKEN"'))
        .exitCode,
    ).toBe(0);
    const [outputCheck] = prepareShellChecks([
      {
        id: "output",
        grader: "sevro.shell",
        configuration: {
          run: "printf 'alpha\\nbeta\\n'",
          expectRegex: "^beta$",
        },
      },
    ]);
    const output = await runShellCheck(outputCheck!, {
      workspace,
      protectedRoots: [protectedRoot],
      privateStateRoot: join(root, "private"),
    });
    expect(output).toEqual({ exitCode: 0, stdout: "alpha\nbeta\n" });
    const [failFast] = prepareShellChecks([
      {
        id: "fail-fast",
        grader: "sevro.shell",
        configuration: {
          run: "false; printf 'wrong\\n'",
          expectExact: "wrong",
        },
      },
    ]);
    const stopped = await runShellCheck(failFast!, {
      workspace,
      protectedRoots: [protectedRoot],
      privateStateRoot: join(root, "private"),
    });
    expect(stopped).toEqual({ exitCode: 1, stdout: "" });
    const [oversized] = prepareShellChecks([
      {
        id: "oversized",
        grader: "sevro.shell",
        configuration: {
          run: "awk 'BEGIN { for (i = 0; i < 1048577; i++) printf \"x\" }'",
          expectRegex: "x",
        },
      },
    ]);
    await expect(
      runShellCheck(oversized!, {
        workspace,
        protectedRoots: [protectedRoot],
        privateStateRoot: join(root, "private"),
      }),
    ).rejects.toThrow(/1 MiB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
