import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

async function setupFixture() {
  const root = await temporaryFixture(join(tmpdir(), "sevro-ci-setup-test-"));

  const tools = join(root, "bin");
  await mkdir(tools);
  const calls = join(root, "npm-calls.jsonl");
  await writeFile(calls, "");
  const target = {
    darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
    linux: {
      arm64: "aarch64-unknown-linux-musl",
      x64: "x86_64-unknown-linux-musl",
    },
  } as Record<string, Record<string, string>>;
  const codex = `node_modules/@openai/codex-${process.platform}-${process.arch}/vendor/${target[process.platform]?.[process.arch] ?? "unsupported"}/bin/codex`;
  const claude = `node_modules/@anthropic-ai/claude-code-${process.platform}-${process.arch}/claude`;
  await writeFile(
    join(tools, "npm"),
    `#!${process.execPath}
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
await appendFile(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const prefix = args[args.indexOf("--prefix") + 1];
for (const [relative, version] of ${JSON.stringify([
      [codex, "codex-cli 0.160.1"],
      [claude, "2.1.284 (Claude Code)"],
    ])}) {
  const binary = join(prefix, relative);
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, "#!/bin/sh\\nprintf '%s\\n' '" + version + "'\\n", { mode: 0o700 });
}
`,
    { mode: 0o700 },
  );
  return { root, tools, calls, codex, claude, cache: join(root, "cache") };
}

async function runSetup(
  fixture: Awaited<ReturnType<typeof setupFixture>>,
  hit: boolean,
) {
  const githubPath = join(fixture.root, "github-path");
  const githubEnv = join(fixture.root, "github-env");
  await writeFile(githubPath, "");
  await writeFile(githubEnv, "");
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../scripts/setup-ci-codex.ts"),
    ],
    {
      env: {
        ...process.env,
        PATH: fixture.tools + ":" + (process.env.PATH ?? ""),
        GITHUB_PATH: githubPath,
        GITHUB_ENV: githubEnv,
        SEVRO_CI_NATIVE_CACHE: fixture.cache,
        SEVRO_CI_NATIVE_CACHE_HIT: String(hit),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const environment = await readFile(githubEnv, "utf8");
  const temporary = environment.match(/^TMPDIR=(.+)$/m)?.[1];
  if (temporary) roots.push(dirname(temporary));
  return {
    stdout,
    stderr,
    code,
    environment,
    paths: await readFile(githubPath, "utf8"),
  };
}

test("CI native setup reuses cached installs in fresh tool roots and checks both versions", async () => {
  const fixture = await setupFixture();
  const cold = await runSetup(fixture, false);
  expect(cold.code, cold.stderr).toBe(0);
  const warm = await runSetup(fixture, true);
  expect(warm.code, warm.stderr).toBe(0);
  const calls = (await readFile(fixture.calls, "utf8")).trim().split("\n");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("@openai/codex@0.160.1");
  expect(calls[0]).toContain("@anthropic-ai/claude-code@2.1.284");
  expect(calls[0]).toContain("--ignore-scripts");
  expect(warm.stdout).toContain("codex-cli 0.160.1 installed at");
  expect(warm.stdout).toContain("2.1.284 (Claude Code) installed at");
  expect(warm.paths.trim().split("\n")).toHaveLength(2);
  expect(warm.paths).not.toBe(cold.paths);
  expect(warm.paths).not.toContain(fixture.cache);
  expect(warm.environment).not.toBe(cold.environment);
});

test.each(["codex", "claude"] as const)(
  "CI native setup refuses a cached %s with a different version",
  async (host) => {
    const fixture = await setupFixture();
    const cold = await runSetup(fixture, false);
    expect(cold.code, cold.stderr).toBe(0);
    await writeFile(
      join(fixture.cache, fixture[host]),
      "#!/bin/sh\nprintf '%s\\n' 'wrong-version'\n",
      { mode: 0o700 },
    );
    const warm = await runSetup(fixture, true);
    expect(warm.code).toBe(1);
    expect(warm.stderr).toContain(
      "native version differs from the pinned version",
    );
    expect(warm.paths).toBe("");
    expect(warm.environment).toBe("");
    expect(
      (await readFile(fixture.calls, "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  },
);
