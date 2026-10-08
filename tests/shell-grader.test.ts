import { expectUnknown } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { existsSync, watch } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessShellCheck,
  prepareShellChecks,
  runShellCheck,
} from "../src/graders/shell";
const roots: string[] = [];
const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function outputCheck(configuration: Record<string, unknown>) {
  return defined(
    prepareShellChecks([
      { id: "output", grader: "sevro.shell", configuration },
    ])[0],
  );
}

async function shellWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "sevro-shell-boundary-"));
  roots.push(root);
  const workspace = join(root, "fixture");
  await mkdir(workspace);
  return {
    workspace,
    protectedRoots: [join(import.meta.dir, "..", "src")],
    privateStateRoot: join(root, "private"),
  };
}

test("shell declarations retain UTF-8 output and regex limits at their public boundary", () => {
  expect(() =>
    prepareShellChecks([
      { id: "", grader: "sevro.shell", configuration: { run: "true" } },
    ]),
  ).toThrow("invalid shell check declaration");
  expect(
    outputCheck({ run: "true", expectExact: "🙂".repeat(262144) })
      .captureStdout,
  ).toBe(true);
  expect(() =>
    outputCheck({ run: "true", expectExact: "🙂".repeat(262145) }),
  ).toThrow("invalid exact shell output expectation");
  expect(() => outputCheck({ run: "true", expectExact: 42 })).toThrow(
    "invalid exact shell output expectation",
  );
  expect(
    outputCheck({ run: "true", expectRegex: "x".repeat(4096) }).captureStdout,
  ).toBe(true);
  expect(() =>
    outputCheck({ run: "true", expectRegex: "x".repeat(4097) }),
  ).toThrow("invalid shell regex pattern");
  expect(() => outputCheck({ run: "true", notRegex: 42 })).toThrow(
    "invalid shell regex pattern",
  );
});

test("shell assessment refuses missing required stdout and distinguishes regex mismatch", () => {
  const check = outputCheck({ run: "printf ready", expectRegex: "^ready$" });
  expect(() => assessShellCheck(check, { exitCode: 0, stdout: null })).toThrow(
    "shell stdout observation is missing",
  );
  expect(
    assessShellCheck(check, { exitCode: 0, stdout: "private unmatched bytes" }),
  ).toEqual({
    passed: false,
    detail: "expected shell output pattern did not match",
  });
  expect(
    assessShellCheck(check, { exitCode: 0, stdout: "ready\n" }).passed,
  ).toBe(true);
});

test("a pre-aborted shell check refuses admission before preparing runtime state", async () => {
  const options = await shellWorkspace();
  const controller = new AbortController();
  controller.abort();
  expect(
    runShellCheck(outputCheck({ run: "true" }), {
      ...options,
      signal: controller.signal,
    }),
  ).rejects.toThrow("shell check cancelled");
  expect(existsSync(join(options.workspace, ".git/sevro-runtime"))).toBe(false);
});

test("shell cancellation requested during preparation stops its eventual owned process", async () => {
  if (!isolatedNativeHost) return;
  const options = await shellWorkspace();
  const controller = new AbortController();
  const running = runShellCheck(
    outputCheck({ run: "sleep 30", timeoutMs: 5000 }),
    { ...options, signal: controller.signal },
  );
  controller.abort();
  expect(running).rejects.toThrow("shell check cancelled");
});

test("active shell cancellation stops only the receipt-bound owned process", async () => {
  if (!isolatedNativeHost) return;
  const options = await shellWorkspace();
  const controller = new AbortController();
  const ready = Promise.withResolvers<undefined>();
  const observer = watch(options.workspace, (_event, name) => {
    if (name === "ready") ready.resolve(undefined);
  });
  const timer = setTimeout(() => {
    ready.reject(new Error("owned shell did not publish readiness"));
  }, 2000);
  let running: Promise<unknown> | undefined;
  try {
    const check = outputCheck({
      run: 'printf "%s\\n" "$$" > ready; while :; do printf . >> heartbeat; sleep 0.05; done',
      timeoutMs: 5000,
    });
    running = runShellCheck(check, {
      ...options,
      signal: controller.signal,
    }).catch((cause: unknown) => cause);
    await ready.promise;
    const pid = Number(
      await readFile(join(options.workspace, "ready"), "utf8"),
    );
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    const heartbeat = join(options.workspace, "heartbeat");
    await Bun.sleep(100);
    expect(existsSync(heartbeat)).toBe(true);
    controller.abort();
    expect(await running).toMatchObject({ message: "shell check cancelled" });
    const stoppedAt = await readFile(heartbeat, "utf8");
    await Bun.sleep(150);
    expect(await readFile(heartbeat, "utf8")).toBe(stoppedAt);
    if (process.platform === "darwin")
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH|No such process/);
  } finally {
    controller.abort();
    if (running) await running;
    observer.close();
    clearTimeout(timer);
  }
});

test("shell runtime refuses a regular file in place of its required isolated UV cache", async () => {
  if (!isolatedNativeHost) return;
  const options = await shellWorkspace();
  const directory = join(options.workspace, ".git/sevro-runtime");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "uv-cache"), "not a directory");
  expect(
    runShellCheck(outputCheck({ run: "true" }), {
      ...options,
      uvRuntimeCache: true,
    }),
  ).rejects.toThrow("isolated UV cache is missing");
});
test("shell declarations reject invalid commands and bounds", () => {
  const check = (configuration: Record<string, unknown>) =>
    prepareShellChecks([{ id: "check", grader: "sevro.shell", configuration }]);
  expect(defined(check({ run: "test -f README.md" })[0])).toMatchObject({
    expectedExitCode: 0,
    timeoutMs: 30000,
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
    assessShellCheck(defined(check), { exitCode: 0, stdout: "first\nsecond\n" })
      .passed,
  ).toBeTrue();
  expect(
    assessShellCheck(defined(check), { exitCode: 0, stdout: "first\nother\n" })
      .passed,
  ).toBeFalse();
  expect(
    assessShellCheck(defined(check), { exitCode: 1, stdout: "first\nsecond\n" })
      .detail,
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
    assessShellCheck(defined(negative), { exitCode: 0, stdout: "forbidden\n" })
      .passed,
  ).toBeFalse();
});
test("timed out shell checks stop without returning a result", async () => {
  if (!isolatedNativeHost) return;
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
    expect(
      runShellCheck(defined(check), {
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
  if (!isolatedNativeHost) return;
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
          run: 'test -d "$UV_CACHE_DIR" && test "$UV_OFFLINE" = 1 && test "$PYTHONDONTWRITEBYTECODE" = 1 && test -n "$UV_PROJECT_ENVIRONMENT" && sevro-tool',
          expectExact: "ready",
        },
      },
    ]);
    const result = await runShellCheck(defined(check), {
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
test("shell scratch files stay inside Git metadata", async () => {
  if (!isolatedNativeHost) return;
  const root = await mkdtemp(join(tmpdir(), "sevro-shell-scratch-"));
  const workspace = join(root, "fixture");
  try {
    await mkdir(join(workspace, ".git"), { recursive: true });
    const [check] = prepareShellChecks([
      {
        id: "scratch",
        grader: "sevro.shell",
        configuration: {
          run: 'printf home >"$HOME/probe" && printf temp >"$TMPDIR/probe"',
        },
      },
    ]);
    const result = await runShellCheck(defined(check), {
      workspace,
      protectedRoots: [join(import.meta.dir, "..", "src")],
      privateStateRoot: join(root, "private"),
    });
    expect(result.exitCode).toBe(0);
    expect(
      existsSync(
        join(workspace, ".git", "sevro-runtime", "check-home", "probe"),
      ),
    ).toBeTrue();
    expect(
      existsSync(
        join(workspace, ".git", "sevro-runtime", "check-tmp", "probe"),
      ),
    ).toBeTrue();
    expect(existsSync(join(workspace, ".sevro-check-home"))).toBeFalse();
    expect(existsSync(join(workspace, ".sevro-check-tmp"))).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("shell check sees the fixture but cannot read or write protected sources", async () => {
  if (!isolatedNativeHost) return;
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
      return runShellCheck(defined(check), {
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
    const output = await runShellCheck(defined(outputCheck), {
      workspace,
      protectedRoots: [protectedRoot],
      privateStateRoot: join(root, "private"),
    });
    expectUnknown(output).toEqual({ exitCode: 0, stdout: "alpha\nbeta\n" });
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
    const stopped = await runShellCheck(defined(failFast), {
      workspace,
      protectedRoots: [protectedRoot],
      privateStateRoot: join(root, "private"),
    });
    expectUnknown(stopped).toEqual({ exitCode: 1, stdout: "" });
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
    expect(
      runShellCheck(defined(oversized), {
        workspace,
        protectedRoots: [protectedRoot],
        privateStateRoot: join(root, "private"),
      }),
    ).rejects.toThrow(/1 MiB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
