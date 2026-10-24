import { expect } from "bun:test";
import {
  chmod,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defined, parseCliResult } from "./assertions";
import { syntheticClaudeLogin } from "./claude-login";
import { createTemporaryFixtures } from "./filesystem";

export async function conflictingCacheSource(
  kind: string,
  root: string,
  project: string,
  cache: string,
) {
  const paths: Record<string, string> = {
    project,
    results: join(root, "results"),
    credential: join(homedir(), ".codex"),
    broad: homedir(),
  };
  const source = paths[kind] ?? cache;
  if (kind === "results") await mkdir(source);
  if (kind === "file") {
    await rm(cache, { recursive: true });
    await writeFile(cache, "file");
  }
  if (kind === "readonly") await chmod(cache, 0o500);
  return source;
}

export async function fixture(roots: string[], checks: unknown[] = []) {
  const { temporaryFixture } = createTemporaryFixtures(roots);

  const root = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-runtime-cli-")),
  );

  const project = join(root, "project");
  await mkdir(project);
  const caseFile = join(root, "case.json");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "runtime",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [{ message: "base", files: { "README.md": "fixture\n" } }],
      },
      checks,
      requiredEvidence: [],
    }),
  );
  const adapter = join(root, "adapter.ts");
  await writeFile(
    adapter,
    'export default { id: "test.runtime", model: "synthetic", effort: "low", async run() { return { finalMessage: "ready", complete: true, actualCondition: "passive" }; } };\n',
  );
  const args = [
    process.execPath,
    join(import.meta.dir, "../../src/cli.ts"),
    "run",
    "--json",
    "--case-file",
    caseFile,
    "--adapter-module",
    adapter,
    "--project-root",
    project,
    "--results-root",
    join(root, "results"),
    "--runner-build-digest",
    "a".repeat(64),
    "--project-digest",
    "b".repeat(64),
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ];
  return { root, project, args };
}

export async function invoke(
  args: string[],
  environment: Record<string, string | undefined> = {},
) {
  const child = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, result: parseCliResult(stdout) };
}

export async function libcProbe(directory: string): Promise<string> {
  await mkdir(directory);
  const binary = join(directory, "libc-filesystem-probe");
  const compiled = Bun.spawnSync([
    "/usr/bin/cc",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(import.meta.dir, "libc-filesystem-probe.c"),
    "-o",
    binary,
  ]);
  expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
  return binary;
}

export function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function libcCheck(
  binary: string,
  id: string,
  operation: string,
  path: string,
  expected: string | null,
) {
  return {
    id,
    grader: "sevro.shell",
    configuration: {
      run: [binary, operation, path].map(shellLiteral).join(" "),
      expectedExitCode: expected === null ? 1 : 0,
      ...(expected === null
        ? { expectRegex: "^errno=(1|13)$" }
        : { expectExact: expected }),
    },
  };
}

export function libcEnvironmentCheck(
  binary: string,
  id: string,
  operation: string,
  path: string,
  expected: string | null,
) {
  const check = libcCheck(binary, id, operation, "", expected);
  const command = `${shellLiteral(binary)} ${operation} "${path}"`;
  check.configuration.run =
    operation === "realpath"
      ? `resolved=$(${command}); test "$resolved" = "${path}"; printf canonicalized`
      : command;
  return check;
}

export const localeCases = [
  { name: "unset", lang: undefined, expected: "C", pattern: "^C$" },
  {
    name: "set",
    lang: "C.UTF-8",
    expected: "C.UTF-8",
    pattern: "^C\\.UTF-8$",
  },
];

export async function localeHostArguments(
  route: "codex" | "claude",
  root: string,
): Promise<string[]> {
  const binary = join(root, route);
  const credential = join(root, "credential.json");
  await writeFile(credential, syntheticClaudeLogin());
  if (route === "claude") {
    await writeFile(
      binary,
      '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n\' "$LANG"\n',
      { mode: 0o755 },
    );
    return ["--claude-bin", binary, "--claude-credential-file", credential];
  }
  const codex = defined(Bun.which("codex"));
  if (process.platform === "linux")
    await symlink(codex, join(root, "codex-linux-sandbox"));
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-codex\\n'; exit 0; fi
if [ "$1" = sandbox ]; then shift; exec '${codex}' sandbox "$@"; fi
test "$1" = exec || exit 99
printf '%s\\n' '{"type":"thread.started","thread_id":"locale-test"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$LANG"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    { mode: 0o755 },
  );
  return ["--codex-bin", binary, "--codex-auth-file", credential];
}
