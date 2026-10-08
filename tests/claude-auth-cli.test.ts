import { parseCliResult, parseRunEvidence } from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function authEnvironment(
  environment: Record<string, string>,
  home: string,
  root: string,
) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    ...environment,
  };
  if (!Object.hasOwn(environment, "CLAUDE_CODE_OAUTH_TOKEN"))
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!Object.hasOwn(environment, "ANTHROPIC_API_KEY"))
    delete env.ANTHROPIC_API_KEY;
  if (environment.CLAUDE_CONFIG_DIR === "custom")
    env.CLAUDE_CONFIG_DIR = join(root, "custom");
  return env;
}
async function authFixture(
  environment: Record<string, string>,
  files: Record<string, string>,
  explicit?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "sevro-auth-parity-"));
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-auth-binary-"));
  roots.push(root, binRoot);
  const binary = join(binRoot, "claude"),
    caseFile = join(root, "case.json"),
    home = join(root, "home");
  await mkdir(home);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import {readFile} from "node:fs/promises";
import {join} from "node:path";
const args = process.argv.slice(2);
const settings = JSON.parse(await readFile(args[args.indexOf("--settings")+1], "utf8"));
const prompt = args[args.indexOf("-p")+1];
let credential = null;
try { credential = JSON.parse(await readFile(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "utf8")); } catch {}
const api = process.env.ANTHROPIC_API_KEY, oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const protectedAuth = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].every(name => settings.sandbox.credentials.envVars?.some(entry => entry.name === name && entry.mode === "deny")) && process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === "1";
const ready = protectedAuth && (prompt === "environment" ? (api === "AUTH_PARITY_API_SECRET" || oauth === "AUTH_PARITY_OAUTH_SECRET") : credential?.test === prompt && !api && !oauth);
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"11111111-1111-1111-1111-111111111111"}));
console.log(JSON.stringify({type:"result",subtype:"success",is_error:!ready,session_id:"11111111-1111-1111-1111-111111111111",result:ready?"ready":"Authentication selection mismatch"}));
process.exitCode = ready ? 0 : 1;
`,
    { mode: 0o700 },
  );
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "auth",
      prompt: explicit ?? environment.SEVRO_TEST_PROMPT ?? "environment",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
    }),
  );
  return { root, binary, caseFile, home };
}
async function invoke(
  environment: Record<string, string>,
  files: Record<string, string> = {},
  explicit?: string,
) {
  const { root, binary, caseFile, home } = await authFixture(
    environment,
    files,
    explicit,
  );
  const env = authEnvironment(environment, home, root);
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../src/cli.ts"),
      "run",
      "--json",
      "--case-file",
      caseFile,
      "--project-root",
      root,
      "--results-root",
      join(root, "results"),
      "--host",
      "claude",
      "--claude-bin",
      binary,
      ...(explicit
        ? ["--claude-credential-file", join(root, "explicit.json")]
        : []),
      "--model",
      "synthetic",
      "--effort",
      "low",
      "--condition",
      "passive",
      "--trials",
      "1",
      "--threshold",
      "1",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = parseCliResult(stdout);
  const evidence = result.evidencePath
    ? parseRunEvidence(await readFile(result.evidencePath, "utf8"))
    : null;
  return {
    code,
    result,
    evidence,
    diagnostic: stderr + stdout + JSON.stringify(evidence?.diagnostic),
  };
}
test("public CLI reuses existing Claude environment authentication", async () => {
  for (const environment of [
    { CLAUDE_CODE_OAUTH_TOKEN: "AUTH_PARITY_OAUTH_SECRET" },
    { ANTHROPIC_API_KEY: "AUTH_PARITY_API_SECRET" },
    {
      CLAUDE_CODE_OAUTH_TOKEN: "AUTH_PARITY_OAUTH_SECRET",
      ANTHROPIC_API_KEY: "AUTH_PARITY_API_SECRET",
    },
  ] as Array<Record<string, string>>) {
    const run = await invoke(environment);
    expect(run.code, run.diagnostic).toBe(0);
    expect(run.result.task.verdict).toBe("passed");
    expect(JSON.stringify(run.evidence)).not.toContain(
      "AUTH_PARITY_OAUTH_SECRET",
    );
    expect(JSON.stringify(run.evidence)).not.toContain(
      "AUTH_PARITY_API_SECRET",
    );
  }
});
test("public CLI reuses the saved Claude login before Keychain", async () => {
  const credential = JSON.stringify({
    test: "saved-login",
    accessToken: "AUTH_PARITY_FILE_SECRET",
  });
  for (const [environment, files] of [
    [
      { SEVRO_TEST_PROMPT: "saved-login" },
      { "home/.claude/.credentials.json": credential },
    ],
    [
      { SEVRO_TEST_PROMPT: "saved-login", CLAUDE_CONFIG_DIR: "custom" },
      { "custom/.credentials.json": credential },
    ],
  ] as Array<[Record<string, string>, Record<string, string>]>) {
    const run = await invoke(environment, files);
    expect(run.code, run.diagnostic).toBe(0);
    expect(run.result.task.verdict).toBe("passed");
    expect(JSON.stringify(run.evidence)).not.toContain(
      "AUTH_PARITY_FILE_SECRET",
    );
  }
});
test("public CLI preserves explicit credentials and refuses invalid selected files", async () => {
  const environment = {
    CLAUDE_CODE_OAUTH_TOKEN: "AUTH_PARITY_OAUTH_SECRET",
    ANTHROPIC_API_KEY: "AUTH_PARITY_API_SECRET",
  };
  const explicit = await invoke(
    environment,
    {
      "explicit.json": JSON.stringify({
        test: "explicit-login",
        accessToken: "AUTH_PARITY_FILE_SECRET",
      }),
    },
    "explicit-login",
  );
  expect(explicit.code, explicit.diagnostic).toBe(0);
  expect(JSON.stringify(explicit.evidence)).not.toContain(
    "AUTH_PARITY_FILE_SECRET",
  );
  const selectedMissing = await invoke(environment, {}, "explicit-login");
  expect(selectedMissing.code).toBe(2);
  expect(selectedMissing.result.task.verdict).toBe("not_assessed");
  const oversized = await invoke(
    { SEVRO_TEST_PROMPT: "saved-login" },
    { "home/.claude/.credentials.json": "x".repeat(1024 * 1024 + 1) },
  );
  expect(oversized.code).toBe(2);
  expect(oversized.result.task.verdict).toBe("not_assessed");
  const preferredEnvironment = await invoke(environment, {
    "home/.claude/.credentials.json": "not-a-valid-login",
  });
  expect(preferredEnvironment.code, preferredEnvironment.diagnostic).toBe(0);
});
