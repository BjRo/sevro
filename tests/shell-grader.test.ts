import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareShellChecks, runShellCheck } from "../src/graders/shell";

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
    expect(await run("test -f README.md")).toBe(0);
    expect(
      await run(`cat '${join(protectedRoot, "secret.txt")}' >/dev/null`),
    ).not.toBe(0);
    expect(await run(`mkdir '${join(protectedRoot, "new")}'`)).not.toBe(0);
    expect(
      await run('test -z "$OPENAI_API_KEY$ANTHROPIC_API_KEY$GH_TOKEN"'),
    ).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
