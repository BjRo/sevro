import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { syntheticClaudeLogin } from "../../fixtures/claude-login";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import { fixture, invoke } from "../../fixtures/runtime-cli";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("CLI seeds a private writable runtime without changing the host cache", async () => {
  const { root, project, args } = await fixture(roots, [
    {
      id: "cache",
      grader: "sevro.shell",
      configuration: {
        run: 'cat "$PUBLIC_CACHE_DIR/value"; printf private > "$PUBLIC_CACHE_DIR/value"',
        expectExact: "host cache",
      },
    },
  ]);
  const source = join(root, "host-cache");
  await mkdir(source);
  await writeFile(join(source, "value"), "host cache\n");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: {
        set: { PUBLIC_CACHE_DIR: "{{sevro.runtime}}/dependencies" },
      },
      runtime: {
        seedDirectories: [
          { source, target: "dependencies", roles: ["checks"] },
        ],
      },
    }),
  );
  const run = await invoke([...args, "--shell-isolation"]);
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(await readFile(join(source, "value"), "utf8")).toBe("host cache\n");
});

test("CLI refuses runtime seed links escaping their declared directory", async () => {
  const { root, project, args } = await fixture(roots);
  const source = join(root, "host-cache");
  await mkdir(source);
  const secret = join(project, "private-input");
  await writeFile(secret, "evaluator private input");
  await symlink(secret, join(source, "escape"));
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { seedDirectories: [{ source, target: "dependencies" }] },
    }),
  );
  const run = await invoke(args);
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
});

test("CLI separates candidate and check runtime seeds", async () => {
  const { root, project, args } = await fixture(roots, [
    {
      id: "answer",
      grader: "sevro.regex",
      configuration: { pattern: "^host cache$" },
    },
    {
      id: "cache",
      grader: "sevro.shell",
      configuration: {
        run: 'cat "$PUBLIC_CACHE_DIR/value"',
        expectExact: "host cache",
      },
    },
  ]);
  const source = join(root, "host-cache");
  await mkdir(source);
  await writeFile(join(source, "value"), "host cache\n");
  const binary = join(root, "claude");
  await writeFile(
    binary,
    '#!/bin/sh\nanswer=$(/bin/cat "$PUBLIC_CACHE_DIR/value")\nprintf candidate > "$PUBLIC_CACHE_DIR/value"\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n\' "$answer"\n',
  );
  await chmod(binary, 0o755);
  const credential = join(root, "credential.json");
  await writeFile(credential, syntheticClaudeLogin());
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: {
        set: { PUBLIC_CACHE_DIR: "{{sevro.runtime}}/dependencies" },
      },
      runtime: {
        seedDirectories: [
          { source, target: "dependencies", roles: ["candidate", "checks"] },
        ],
      },
    }),
  );
  const native = args.filter(
    (_value, index) =>
      index !== args.indexOf("--adapter-module") &&
      index !== args.indexOf("--adapter-module") + 1,
  );
  const run = await invoke([
    ...native,
    "--host",
    "claude",
    "--claude-bin",
    binary,
    "--claude-credential-file",
    credential,
    "--model",
    "synthetic",
    "--effort",
    "low",
    "--shell-isolation",
  ]);
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(await readFile(join(source, "value"), "utf8")).toBe("host cache\n");
});

test("CLI enables declared native goals in the Claude runtime policy", async () => {
  const { root, project, args } = await fixture(roots, [
    {
      id: "answer",
      grader: "sevro.regex",
      configuration: { pattern: "^ready$" },
    },
  ]);
  const binary = join(root, "claude");
  await writeFile(
    binary,
    '#!/bin/sh\nwhile [ "$#" -gt 1 ]; do if [ "$1" = --settings ]; then settings=$2; break; fi; shift; done\n/usr/bin/grep -q \'"disableAllHooks":false\' "$settings" || exit 8\ntest "$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB" = 1 || exit 9\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
  );
  await chmod(binary, 0o755);
  const credential = join(root, "credential.json");
  await writeFile(credential, syntheticClaudeLogin());
  await writeFile(
    join(project, "sevro.json"),
    '{"format":"sevro.runtime.v1","hooks":{"nativeGoal":true}}',
  );
  const native = args.filter(
    (_value, index) =>
      index !== args.indexOf("--adapter-module") &&
      index !== args.indexOf("--adapter-module") + 1,
  );
  const run = await invoke([
    ...native,
    "--host",
    "claude",
    "--claude-bin",
    binary,
    "--claude-credential-file",
    credential,
    "--model",
    "synthetic",
    "--effort",
    "low",
  ]);
  expect(run.code, JSON.stringify(run.result)).toBe(0);
});

test("CLI never falls back after a selected runtime seed is unreadable", async () => {
  const { root, project, args } = await fixture(roots);
  const source = join(root, "host-cache");
  await mkdir(source);
  await symlink(join(root, "missing"), join(source, "broken"));
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { seedDirectories: [{ source, target: "dependencies" }] },
    }),
  );
  const run = await invoke(args);
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
});

test("CLI limits dependency seed slots to selected execution roles", async () => {
  const { root, project, args } = await fixture(roots, [
    {
      id: "scope",
      grader: "sevro.shell",
      configuration: {
        run: 'test ! -e "$PUBLIC_CACHE_DIR/candidate"; cat "$PUBLIC_CACHE_DIR/check/value"',
        expectExact: "checker dependency",
      },
    },
  ]);
  const source = join(root, "dependencies");
  await mkdir(source);
  await writeFile(join(source, "value"), "checker dependency");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PUBLIC_CACHE_DIR: "{{sevro.runtime}}" } },
      runtime: {
        seedDirectories: [
          { source, target: "candidate", roles: ["candidate"] },
          { source, target: "check", roles: ["checks"] },
        ],
      },
    }),
  );
  const run = await invoke([...args, "--shell-isolation"]);
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(await readFile(join(source, "value"), "utf8")).toBe(
    "checker dependency",
  );
});

test.each([
  { roles: [] },
  { roles: ["candidate", "candidate"] },
  { roles: ["unknown"] },
])("CLI refuses invalid seed role selection $roles", async ({ roles }) => {
  const { root, project, args } = await fixture(roots);
  const source = join(root, "dependencies");
  await mkdir(source);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { seedDirectories: [{ source, target: "cache", roles }] },
    }),
  );
  expect((await invoke([...args, "--dry"])).code).toBe(64);
});

test("CLI materializes verified executable bytes, internal links, and empty directories", async () => {
  const { root, project, args } = await fixture(roots, [
    {
      id: "bytes",
      grader: "sevro.shell",
      configuration: {
        run: 'test -d "$PUBLIC_CACHE_DIR/empty"; test ! -L "$PUBLIC_CACHE_DIR/alias"; "$PUBLIC_CACHE_DIR/alias"',
        expectExact: "verified executable",
      },
    },
  ]);
  const source = join(root, "dependencies");
  await mkdir(join(source, "empty"), { recursive: true });
  await writeFile(
    join(source, "tool"),
    "#!/bin/sh\nprintf 'verified executable'\n",
    { mode: 0o755 },
  );
  await symlink("tool", join(source, "alias"));
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PUBLIC_CACHE_DIR: "{{sevro.runtime}}/cache" } },
      runtime: {
        seedDirectories: [{ source, target: "cache", roles: ["checks"] }],
      },
    }),
  );
  const result = await invoke([...args, "--shell-isolation"]);
  expect(result.code, JSON.stringify(result.result)).toBe(0);
});
