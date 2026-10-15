import { expectUnknown } from "../fixtures/assertions";
import {
  defined,
  fixtureCase,
  objectContaining,
  parseCliResult,
  parseTrial,
} from "../fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedNativeHost, invoke } from "../fixtures/cli-fixtures";
import { createFixture } from "../fixtures/cli-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = createFixture(roots);

async function claudeCacheFixture() {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const binaryRoot = await mkdtemp(join(tmpdir(), "sevro-cache-bin-"));
  roots.push(binaryRoot);
  const binary = join(binaryRoot, "claude");
  const credentialFile = join(projectRoot, "credential.json");
  const uvCacheDir = join(binaryRoot, "uv-cache");
  await mkdir(uvCacheDir);
  await writeFile(join(uvCacheDir, "sentinel"), "curated");
  await writeFile(credentialFile, '{"test":"synthetic-login"}', {
    mode: 0o600,
  });
  const definition = fixtureCase();
  definition.fixture = {
    kind: "generated",
    commits: [
      { message: "chore: initial", files: { "README.md": "fixture\n" } },
    ],
  };
  await writeFile(caseFile, JSON.stringify(definition));
  await writeFile(
    binary,
    `#!${process.execPath}
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, join } from "node:path";
if (Object.hasOwn(process.env, "DARROW_CACHE_DIR")) process.exit(8);
const home = await realpath(process.env.HOME);
const path = relative(join(process.cwd(), ".git"), home);
if (!isAbsolute(home) || path === ".." || path.startsWith("../") || isAbsolute(path)) process.exit(9);
if (await readFile(join(process.env.UV_CACHE_DIR, "sentinel"), "utf8") !== "curated" ||
    process.env.UV_OFFLINE !== "1" || process.env.PYTHONDONTWRITEBYTECODE !== "1") process.exit(10);
await mkdir(join(home, ".tool-cache"), { recursive: true });
await writeFile(join(home, ".tool-cache", "probe"), "isolated");
await writeFile(".git/candidate-home", home);
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ready" }) + "\\n");
`,
    { mode: 0o700 },
  );
  const command = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  return {
    caseFile,
    command: [
      ...command,
      "--host",
      "claude",
      "--claude-bin",
      binary,
      "--claude-credential-file",
      credentialFile,
      "--claude-uv-cache-dir",
      uvCacheDir,
      "--model",
      "synthetic",
      "--effort",
      "low",
    ],
  };
}

test("CLI curated Claude runtime leaves repository caches to tools", async () => {
  if (!isolatedNativeHost) return;
  const { command } = await claudeCacheFixture();
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DARROW_CACHE_DIR: "/unavailable-caller-cache" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const result = parseCliResult(stdout);
  expect(code, stderr + stdout).toBe(0);
  expect(result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "passed" },
  });
});

test("CLI curated shell grading leaves repository caches to tools", async () => {
  if (!isolatedNativeHost) return;
  const { command, caseFile } = await claudeCacheFixture();
  const definition = fixtureCase();
  definition.checks.push({
    id: "isolated-cache",
    grader: "sevro.shell",
    configuration: {
      run: 'test -z "${DARROW_CACHE_DIR+x}" && test "$(cat "$UV_CACHE_DIR/sentinel")" = curated && test "$UV_OFFLINE" = 1 && test "$HOME" != "$(cat .git/candidate-home)" && mkdir -p "$HOME/.tool-cache" && printf isolated > "$HOME/.tool-cache/probe" && test "$(git status --porcelain)" = ""',
    },
  });
  await writeFile(caseFile, JSON.stringify(definition));
  const run = await invoke([...command, "--shell-isolation"], "pass", {
    DARROW_CACHE_DIR: "/unavailable-caller-cache",
  });
  expect(run.code, run.stderr + JSON.stringify(run.result)).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  expectUnknown(
    defined(defined(run.result.cases[0]).trials[0]).checks,
  ).toContainEqual(
    objectContaining({ id: "isolated-cache", status: "passed" }),
  );
});

test("CLI runs its bundled Claude route with isolated credentials", async () => {
  if (!isolatedNativeHost) return;
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const credentialFile = join(projectRoot, "claude-credentials.json");
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-claude-bin-"));
  roots.push(binRoot);
  const binary = join(binRoot, "claude-wrapper");
  await writeFile(credentialFile, '{"test":"private-login"}', {
    mode: 0o600,
  });
  await writeFile(
    binary,
    [
      "#!/bin/sh",
      'test -r "$CLAUDE_CONFIG_DIR/.credentials.json" || exit 3',
      'printf \'%s\\n\' \'{"type":"result","subtype":"success","is_error":false,"result":"ready","usage":{"input_tokens":1,"output_tokens":2},"total_cost_usd":0.01}\'',
    ].join("\n") + "\n",
    { mode: 0o700 },
  );
  const withoutAdapter = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  const claudeArgs = [
    ...withoutAdapter,
    "--host",
    "claude",
    "--claude-bin",
    binary,
    "--claude-credential-file",
    credentialFile,
    "--model",
    "sonnet",
    "--effort",
    "low",
  ];
  const run = await invoke(claudeArgs);
  expect(run.code).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const trial = parseTrial(
    await readFile(
      defined(defined(defined(run.result.cases[0]).trials[0]).artifactPath),
      "utf8",
    ),
  );
  expect(defined(trial.evidence.routes[0])).toMatchObject({
    host: "sevro.host.claude",
    model: "sonnet",
  });
  const invalid = await invoke([...args, ...claudeArgs.slice(-10)]);
  expect(invalid.code).toBe(64);
});
