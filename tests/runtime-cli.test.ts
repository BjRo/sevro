import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defined,
  parseCliResult,
  parseRunEvidence,
} from "./fixtures/assertions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(checks: unknown[] = []) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-runtime-cli-")),
  );
  roots.push(root);
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
    join(import.meta.dir, "../src/cli.ts"),
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

async function invoke(
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

const localeCases = [
  { name: "unset", lang: undefined, expected: "C", pattern: "^C$" },
  {
    name: "set",
    lang: "C.UTF-8",
    expected: "C.UTF-8",
    pattern: "^C\\.UTF-8$",
  },
];

test.each(localeCases)(
  "CLI isolated shell locale uses the caller default when LANG is $name",
  async ({ lang, expected }) => {
    const { args } = await fixture([
      {
        id: "locale",
        grader: "sevro.shell",
        configuration: { run: 'printf "%s" "$LANG"', expectExact: expected },
      },
    ]);
    const run = await invoke([...args, "--shell-isolation"], { LANG: lang });
    expect(run.code, JSON.stringify(run.result)).toBe(0);
    expect(run.result.task.verdict).toBe("passed");
  },
);

async function localeHostArguments(
  route: "codex" | "claude",
  root: string,
): Promise<string[]> {
  const binary = join(root, route);
  const credential = join(root, "credential.json");
  await writeFile(credential, '{"test":"synthetic"}');
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

for (const route of ["codex", "claude"] as const) {
  test.each(localeCases)(
    `CLI ${route} candidate locale uses the caller default when LANG is $name`,
    async ({ lang, pattern }) => {
      const { root, args } = await fixture([
        {
          id: "locale",
          grader: "sevro.regex",
          configuration: { pattern },
        },
      ]);
      const native = args.filter(
        (_value, index) =>
          index !== args.indexOf("--adapter-module") &&
          index !== args.indexOf("--adapter-module") + 1,
      );
      const hostArguments = await localeHostArguments(route, root);
      const run = await invoke(
        [
          ...native,
          "--host",
          route,
          ...hostArguments,
          "--model",
          "synthetic",
          "--effort",
          "low",
        ],
        { LANG: lang },
      );
      expect(run.code, JSON.stringify(run.result)).toBe(0);
      expect(run.result.task.verdict).toBe("passed");
    },
  );
}

test("CLI rejects malformed repository runtime configuration before execution", async () => {
  const { project, args } = await fixture();
  await writeFile(join(project, "sevro.json"), "{");
  const run = await invoke(args);
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
  expect(run.result.diagnostic?.message).toContain("runtime configuration");
});

test.skipIf(process.getuid?.() === 0)(
  "CLI reports operation and path for an unreadable selected PATH directory",
  async () => {
    const { root, project, args } = await fixture();
    const blocked = join(root, "blocked-path");
    await mkdir(blocked);
    await chmod(blocked, 0);
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { inherit: ["PATH"] },
      }),
    );
    try {
      const run = await invoke([...args, "--dry"], { PATH: blocked });
      expect(run.code).toBe(64);
      expect(run.result.diagnostic?.code).toBe("sevro.invocation.invalid");
      expect(run.result.diagnostic?.message).toContain("EACCES");
      expect(run.result.diagnostic?.message).toMatch(
        /filesystem (?:access|lstat|stat|realpath) failed/,
      );
      expect(run.result.diagnostic?.message).toContain(blocked);
    } finally {
      await chmod(blocked, 0o700);
    }
  },
);

test.skipIf(process.getuid?.() === 0)(
  "CLI reports operation and path when an explicit runtime file is inaccessible",
  async () => {
    const { root, args } = await fixture();
    const blocked = join(root, "blocked-config"),
      selected = join(blocked, "runtime.json");
    await mkdir(blocked);
    await chmod(blocked, 0);
    try {
      const run = await invoke(
        [...args, "--runtime-config-file", selected, "--dry"],
      );
      expect(run.code).toBe(64);
      expect(run.result.diagnostic?.code).toBe("sevro.invocation.invalid");
      expect(run.result.diagnostic?.message).toContain("EACCES");
      expect(run.result.diagnostic?.message).toMatch(
        /filesystem (?:access|lstat|stat|realpath) failed/,
      );
      expect(run.result.diagnostic?.message).toContain(selected);
    } finally {
      await chmod(blocked, 0o700);
    }
  },
);

test.skipIf(process.platform !== "darwin" || process.getuid?.() === 0)(
  "CLI accepts inherited macOS PATH with an inaccessible individual tool alias",
  async () => {
    const { project, args } = await fixture();
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { inherit: ["PATH"] },
      }),
    );
    const run = await invoke([...args, "--dry"], {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
    expect(run.code, JSON.stringify(run.result)).toBe(0);
    expect(run.result.execution.status).toBe("not_run");
  },
);

test("CLI warns when using deprecated toolchain options", async () => {
  const { root, args } = await fixture();
  const bin = join(root, "tools");
  await mkdir(bin);
  const run = await invoke([
    ...args,
    "--shell-isolation",
    "--toolchain-bin-dir",
    bin,
  ]);
  expect(run.code, run.stderr).toBe(0);
  expect(run.stderr).toContain("--toolchain-bin-dir is deprecated");
});

test.each([
  { name: "unsupported schema", policy: { format: "sevro.runtime.v2" } },
  {
    name: "unknown property",
    policy: { format: "sevro.runtime.v1", permissive: true },
  },
  {
    name: "missing inherited value",
    policy: {
      format: "sevro.runtime.v1",
      environment: { inherit: ["SEVRO_RUNTIME_MISSING"] },
    },
  },
  {
    name: "NUL environment value",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { SAMPLE: "a\0b" } },
    },
  },
  {
    name: "oversized UTF8 environment value",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { SAMPLE: "界".repeat(5000) } },
    },
  },
  {
    name: "relative PATH entry",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { PATH: "relative:/usr/bin" } },
    },
  },
  {
    name: "empty PATH entry",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { PATH: "/usr/bin:" } },
    },
  },
  {
    name: "control in PATH",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { PATH: "/usr/bin\n" } },
    },
  },
  {
    name: "non-directory PATH entry",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { PATH: "/bin/sh" } },
    },
  },
  {
    name: "missing read root",
    policy: {
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["./missing"] },
    },
  },
  {
    name: "undeclared path variable",
    policy: {
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["${SEVRO_RUNTIME_MISSING}"] },
    },
  },
  {
    name: "invalid path interpolation",
    policy: {
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["${bad-name}"] },
    },
  },
  {
    name: "control in read root",
    policy: {
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["/tmp\u007f"] },
    },
  },
  {
    name: "whole filesystem",
    policy: {
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["/"] },
    },
  },
])("CLI refuses invalid runtime input: $name", async ({ policy }) => {
  const { project, args } = await fixture();
  await writeFile(join(project, "sevro.json"), JSON.stringify(policy));
  const run = await invoke(args, { SEVRO_RUNTIME_MISSING: undefined });
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
});

test("CLI refuses a missing explicit runtime file", async () => {
  const { root, args } = await fixture();
  expect(
    (
      await invoke([
        ...args,
        "--runtime-config-file",
        join(root, "missing.json"),
      ])
    ).code,
  ).toBe(64);
});

test("CLI ignores missing PATH entries and broken tool links", async () => {
  const { root, project, args } = await fixture();
  const bin = join(root, "tools");
  await mkdir(bin);
  await symlink(join(root, "missing-tool"), join(bin, "broken"));
  await symlink(project, join(bin, "directory-link"));
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PATH: `${bin}:${join(root, "missing-bin")}` } },
    }),
  );
  const run = await invoke(args);
  expect(run.code, run.stderr).toBe(0);
});

test("CLI rejects overlapping seed targets", async () => {
  const { root, project, args } = await fixture();
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: {
        seedDirectories: [
          { source, target: "cache" },
          { source, target: "cache" },
        ],
      },
    }),
  );
  expect((await invoke(args)).code).toBe(64);
});

test("CLI rejects cyclic seed directories", async () => {
  const { root, project, args } = await fixture();
  const source = join(root, "seed");
  await mkdir(source);
  await symlink(source, join(source, "cycle"));
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { seedDirectories: [{ source, target: "cache" }] },
    }),
  );
  expect((await invoke(args)).code).toBe(64);
});

test("CLI refuses a seed over the documented byte bound", async () => {
  const { root, project, args } = await fixture();
  const source = join(root, "seed");
  await mkdir(source);
  const large = join(source, "large");
  await writeFile(large, "");
  await truncate(large, 512 * 1024 * 1024 + 1);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { seedDirectories: [{ source, target: "cache" }] },
    }),
  );
  expect((await invoke(args)).code).toBe(64);
});

test("CLI refuses special files in a runtime seed", async () => {
  const { root, project, args } = await fixture();
  const source = join(root, "seed");
  await mkdir(source);
  expect(
    await Bun.spawn(["/usr/bin/mkfifo", join(source, "pipe")], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited,
  ).toBe(0);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { seedDirectories: [{ source, target: "cache" }] },
    }),
  );
  expect((await invoke(args)).code).toBe(64);
});

test("CLI refuses an overfull PATH directory", async () => {
  const { root, project, args } = await fixture();
  const bin = join(root, "tools");
  await mkdir(bin);
  for (let index = 0; index < 4097; index++)
    await writeFile(join(bin, `entry-${index}`), "");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PATH: bin } },
    }),
  );
  expect((await invoke(args)).code).toBe(64);
});

test("CLI refuses mixing selected runtime configuration with legacy toolchain options", async () => {
  const { root, project, args } = await fixture();
  const bin = join(root, "tools");
  await mkdir(bin);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({ format: "sevro.runtime.v1" }),
  );
  const run = await invoke([
    ...args,
    "--shell-isolation",
    "--toolchain-bin-dir",
    bin,
  ]);
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
});

test("CLI protects grader runtime seeds from candidate-created state", async () => {
  const { root, project, args } = await fixture([
    {
      id: "cache",
      grader: "sevro.shell",
      configuration: {
        run: '/bin/cat "$UV_CACHE_DIR/input"',
        expectExact: "original",
      },
    },
  ]);
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(join(source, "input"), "original");
  await writeFile(
    join(root, "adapter.ts"),
    'import {mkdir, writeFile} from "node:fs/promises"; import {join} from "node:path"; export default {id: "test.runtime", model: "synthetic", effort: "low", async run({workspace}) {const cache = join(workspace, ".git/sevro-runtime/checks/cache"); await mkdir(cache, {recursive: true}); await writeFile(join(cache, "input"), "candidate-created"); return {finalMessage: "ready", complete: true, actualCondition: "passive"};}};',
  );
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { UV_CACHE_DIR: "{{sevro.runtime}}/cache" } },
      runtime: { seedDirectories: [{ source, target: "cache" }] },
    }),
  );
  const run = await invoke([...args, "--shell-isolation"]);
  expect(run.code, run.stderr).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
});

test("CLI native-goal policy selects Codex app-server by default", async () => {
  const { root, project, args } = await fixture();
  const adapter = args.indexOf("--adapter-module");
  args.splice(adapter, 2);
  const binary = join(root, "codex-peer");
  await writeFile(
    binary,
    `#!${process.execPath}\nawait import(${JSON.stringify(join(import.meta.dir, "fixtures/app-server-peer.ts"))});\n`,
    { mode: 0o700 },
  );
  const auth = join(root, "auth.json");
  await writeFile(auth, "synthetic");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({ format: "sevro.runtime.v1", hooks: { nativeGoal: true } }),
  );
  const run = await invoke([
    ...args,
    "--host",
    "codex",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    auth,
    "--model",
    "synthetic",
    "--effort",
    "low",
  ]);
  expect(run.code, run.stderr).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(evidence.configuration.redacted.hostConfiguration).toMatchObject({
    candidate: { "sevro.codex.entrypoint": "app-server" },
  });
  expect(
    defined(evidence.trials[0]).observations.find(
      (row) => row.id === "sevro.host.native-goal",
    )?.data.goalStatus,
  ).toBe("complete");
});

test("CLI snapshots declared repository environment in run evidence", async () => {
  const { project, args } = await fixture();
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["SEVRO_RUNTIME_SAMPLE"] },
    }),
  );
  const run = await invoke(args, { SEVRO_RUNTIME_SAMPLE: "from caller" });
  expect(run.code, run.stderr).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(evidence.configuration.redacted.runtimePolicy).toMatchObject({
    format: "sevro.runtime.v1",
    environment: { SEVRO_RUNTIME_SAMPLE: "from caller" },
  });
});

test("CLI identity binds empty seed directories", async () => {
  const { root, project, args } = await fixture();
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { seedDirectories: [{ source, target: "cache" }] },
    }),
  );
  const first = await invoke([...args, "--dry"]);
  expect(first.code, first.stderr).toBe(0);
  const before = parseRunEvidence(
    await readFile(defined(first.result.evidencePath), "utf8"),
  );
  await mkdir(join(source, "empty"));
  const second = await invoke([...args, "--dry"]);
  expect(second.code, second.stderr).toBe(0);
  const after = parseRunEvidence(
    await readFile(defined(second.result.evidencePath), "utf8"),
  );
  expect(after.configuration.digest).not.toBe(before.configuration.digest);
});

test("CLI explicit runtime file replaces repository configuration", async () => {
  const { root, project, args } = await fixture();
  await writeFile(join(project, "sevro.json"), "{");
  const override = join(root, "runtime.json");
  await writeFile(
    override,
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["SEVRO_RUNTIME_SAMPLE"] },
    }),
  );
  const run = await invoke([...args, "--runtime-config-file", override], {
    SEVRO_RUNTIME_SAMPLE: "override",
  });
  expect(run.code, run.stderr).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(evidence.configuration.redacted.runtimePolicy).toMatchObject({
    environment: { SEVRO_RUNTIME_SAMPLE: "override" },
  });
});

test.each(["ANTHROPIC_API_KEY", "HOME", "CODEX_HOME", "NODE_OPTIONS"])(
  "CLI refuses credential or runner environment inheritance: %s",
  async (name) => {
    const { root, project, args } = await fixture();
    const privateValue = join(root, "private-value-must-not-be-retained");
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { inherit: [name] },
      }),
    );
    const run = await invoke(args, {
      [name]: privateValue,
    });
    expect(run.code).toBe(64);
    expect(run.result.evidencePath).toBeNull();
    expect(JSON.stringify(run.result)).not.toContain(
      "private-value-must-not-be-retained",
    );
  },
);

test("CLI inherited PATH executes read-only host tools in isolated checks", async () => {
  const { root, project, args } = await fixture([
    {
      id: "tool",
      grader: "sevro.shell",
      configuration: { run: "probe", expectExact: "from caller" },
    },
  ]);
  const home = join(root, "host-home");
  const bin = join(home, "installation", "bin");
  await mkdir(bin, { recursive: true });
  const tool = join(bin, "probe");
  await writeFile(
    tool,
    '#!/bin/sh\nif printf changed >> "$0" 2>/dev/null; then exit 9; fi\nprintf "%s\\n" "$SEVRO_RUNTIME_SAMPLE"\n',
  );
  await chmod(tool, 0o755);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["PATH", "SEVRO_RUNTIME_SAMPLE"] },
    }),
  );
  const run = await invoke([...args, "--shell-isolation"], {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    SEVRO_RUNTIME_SAMPLE: "from caller",
  });
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  expect(await readFile(tool, "utf8")).not.toContain("changed\n");
});

test("CLI passes declared environment to a Claude candidate", async () => {
  const { root, project, args } = await fixture([
    {
      id: "answer",
      grader: "sevro.regex",
      configuration: { pattern: "^from caller$" },
    },
  ]);
  const binary = join(root, "claude");
  await writeFile(
    binary,
    '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n\' "$SEVRO_RUNTIME_SAMPLE"\n',
  );
  await chmod(binary, 0o755);
  const credential = join(root, "credential.json");
  await writeFile(credential, '{"test":"synthetic"}');
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["SEVRO_RUNTIME_SAMPLE"] },
    }),
  );
  const native = args.filter(
    (_value, index) =>
      index !== args.indexOf("--adapter-module") &&
      index !== args.indexOf("--adapter-module") + 1,
  );
  const run = await invoke(
    [
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
    ],
    { SEVRO_RUNTIME_SAMPLE: "from caller" },
  );
  expect(run.code, JSON.stringify(run.result)).toBe(0);
});

test.each(["linked", "oversized"])(
  "CLI requires a bounded regular runtime file: %s",
  async (kind) => {
    const { root, project, args } = await fixture();
    const config = join(project, "sevro.json");
    if (kind === "linked") {
      const external = join(root, "external.json");
      await writeFile(external, '{"format":"sevro.runtime.v1"}');
      await symlink(external, config);
    } else
      await writeFile(
        config,
        '{"format":"sevro.runtime.v1"}' + " ".repeat(65536),
      );
    const run = await invoke(args);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
  },
);

test("CLI applies explicit non-secret environment values to isolated checks", async () => {
  const { project, args } = await fixture([
    {
      id: "env",
      grader: "sevro.shell",
      configuration: {
        run: 'printf "%s\\n" "$SEVRO_RUNTIME_SAMPLE"',
        expectExact: "configured",
      },
    },
  ]);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: {
        inherit: ["SEVRO_RUNTIME_SAMPLE"],
        set: { SEVRO_RUNTIME_SAMPLE: "configured" },
      },
    }),
  );
  const run = await invoke([...args, "--shell-isolation"], {
    SEVRO_RUNTIME_SAMPLE: "caller",
  });
  expect(run.code, JSON.stringify(run.result)).toBe(0);
});

test("CLI inherited tools can read their installation support files", async () => {
  const { root, project, args } = await fixture([
    {
      id: "tool",
      grader: "sevro.shell",
      configuration: { run: "probe", expectExact: "installed runtime" },
    },
  ]);
  const home = join(root, "host-home");
  const installation = join(home, "installation");
  const bin = join(installation, "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(join(installation, "lib"));
  await writeFile(join(installation, "lib", "value"), "installed runtime\n");
  const tool = join(bin, "probe");
  await writeFile(
    tool,
    '#!/bin/sh\n/bin/cat "$(/usr/bin/dirname "$0")/../lib/value"\n',
  );
  await chmod(tool, 0o755);
  await writeFile(
    join(project, "sevro.json"),
    '{"format":"sevro.runtime.v1","environment":{"inherit":["PATH"]}}',
  );
  const run = await invoke([...args, "--shell-isolation"], {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
  });
  expect(run.code, JSON.stringify(run.result)).toBe(0);
});

test("CLI inherited PATH resolves symlinked tool installations", async () => {
  const { root, project, args } = await fixture([
    {
      id: "tool",
      grader: "sevro.shell",
      configuration: { run: "probe", expectExact: "symlink runtime" },
    },
  ]);
  const home = join(root, "host-home");
  const bin = join(home, "bin");
  const installation = join(home, "tools", "probe", "1");
  await mkdir(bin, { recursive: true });
  await mkdir(join(installation, "bin"), { recursive: true });
  await mkdir(join(installation, "lib"));
  const support = join(installation, "lib", "value");
  await writeFile(support, "symlink runtime\n");
  const tool = join(installation, "bin", "probe");
  await writeFile(tool, `#!/bin/sh\n/bin/cat '${support}'\n`);
  await chmod(tool, 0o755);
  await symlink(tool, join(bin, "probe"));
  await writeFile(
    join(project, "sevro.json"),
    '{"format":"sevro.runtime.v1","environment":{"inherit":["PATH"]}}',
  );
  const run = await invoke([...args, "--shell-isolation"], {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
  });
  expect(run.code, JSON.stringify(run.result)).toBe(0);
});

test("CLI refuses runtime access to protected source before candidate execution", async () => {
  const { project, args } = await fixture();
  const bin = join(project, "bin");
  await mkdir(bin);
  await writeFile(
    join(project, "sevro.json"),
    '{"format":"sevro.runtime.v1","environment":{"inherit":["PATH"]}}',
  );
  const run = await invoke(args, { PATH: `${bin}:/usr/bin:/bin` });
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
  expect(run.result.diagnostic?.message).toContain("protected");
});

test.each(["lexical", "canonical"])(
  "CLI protects both optional-root alias boundaries: %s",
  async (kind) => {
    const { root, project, args } = await fixture();
    const support = join(root, "support");
    await mkdir(support);
    const alias =
      kind === "lexical" ? join(project, "escape") : join(root, "alias");
    await symlink(kind === "lexical" ? support : project, alias);
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { optionalReadOnlyRoots: [alias] },
      }),
    );
    const run = await invoke(args);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
    expect(run.result.diagnostic?.message).toContain("protected");
  },
);

test("CLI never queries metadata providers inside protected source", async () => {
  const { root, project, args } = await fixture();
  const bin = join(project, "bin"),
    marker = join(root, "query-ran");
  await mkdir(bin);
  await writeFile(
    join(bin, "brew"),
    `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 8\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PATH: bin } },
    }),
  );
  const run = await invoke(args);
  expect(run.code).toBe(64);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("CLI rejects whole-home PATH before querying a provider", async () => {
  const { root, project, args } = await fixture();
  const home = join(root, "host-home"),
    marker = join(root, "query-ran");
  await mkdir(home);
  await writeFile(
    join(home, "brew"),
    `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 8\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["PATH"] },
    }),
  );
  const run = await invoke(args, { HOME: home, PATH: home });
  expect(run.code).toBe(64);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test.each(["project", "alias", "dangling"])(
  "CLI rejects absent optional roots across protected boundaries: %s",
  async (kind) => {
    const { root, project, args } = await fixture();
    const alias = join(root, "protected-alias");
    await symlink(
      kind === "dangling" ? join(project, "absent") : project,
      alias,
    );
    const missing = join(
      kind === "project" ? project : alias,
      "missing",
      "child",
    );
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { optionalReadOnlyRoots: [missing] },
      }),
    );
    const run = await invoke(args);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
    expect(run.result.diagnostic?.message).toContain("protected");
  },
);

test.each(["present", "absent"])(
  "CLI protects canonical credential directories through unrelated aliases: %s",
  async (kind) => {
    const { root, project, args } = await fixture();
    const home = join(root, "host-home"),
      credentials = join(root, "credential-target"),
      alias = join(root, "innocent-alias");
    await mkdir(home);
    if (kind === "present") await mkdir(credentials);
    await symlink(credentials, join(home, ".ssh"));
    await symlink(credentials, alias);
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { optionalReadOnlyRoots: [alias] },
      }),
    );
    const run = await invoke(args, { HOME: home });
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
  },
);

test("CLI resolves optional home paths without granting the whole home", async () => {
  const { root, project, args } = await fixture();
  const home = join(root, "operator-home"),
    support = join(home, "support");
  await mkdir(support, { recursive: true });
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      filesystem: { optionalReadOnlyRoots: ["~/support"] },
    }),
  );
  const run = await invoke(args, { HOME: home });
  expect(run.code, run.stderr).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(evidence.configuration.redacted.runtimePolicy).toMatchObject({
    readOnlyRoots: [support],
  });
});

test("CLI rejects malformed runtime bytes before executing", async () => {
  const { project, args } = await fixture();
  await writeFile(join(project, "sevro.json"), Buffer.alloc(30000, 0xff));
  const run = await invoke(args);
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
});

test.skipIf(process.getuid?.() === 0)(
  "CLI rejects unresolved credential protections under an unreadable home",
  async () => {
    const { root, project, args } = await fixture();
    const home = join(root, "unreadable-home"),
      support = join(root, "support");
    await Promise.all([home, support].map((path) => mkdir(path)));
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { optionalReadOnlyRoots: [support] },
      }),
    );
    await chmod(home, 0);
    try {
      const run = await invoke(args, { HOME: home });
      expect(run.code).toBe(64);
      expect(run.result.execution.status).toBe("not_run");
    } finally {
      await chmod(home, 0o700);
    }
  },
);

test("CLI identity binds actual optional grants and skipped evidence", async () => {
  const { root, project, args } = await fixture();
  const support = join(root, "support");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      filesystem: { optionalReadOnlyRoots: [support] },
    }),
  );
  const first = await invoke([...args, "--dry"]);
  expect(first.code, first.stderr).toBe(0);
  const before = parseRunEvidence(
    await readFile(defined(first.result.evidencePath), "utf8"),
  );
  expect(before.configuration.redacted.runtimePolicy).toMatchObject({
    readOnlyRoots: [],
    skippedOptionalReadOnlyRoots: [support],
  });
  await mkdir(support);
  const second = await invoke([...args, "--dry"]);
  expect(second.code, second.stderr).toBe(0);
  const after = parseRunEvidence(
    await readFile(defined(second.result.evidencePath), "utf8"),
  );
  expect(after.configuration.redacted.runtimePolicy).toMatchObject({
    readOnlyRoots: [support],
    skippedOptionalReadOnlyRoots: [],
  });
  expect(after.configuration.digest).not.toBe(before.configuration.digest);
});

test("CLI applies declared read-only roots outside PATH", async () => {
  const { root, project, args } = await fixture([
    {
      id: "runtime",
      grader: "sevro.shell",
      configuration: {
        run: 'cat "$UV_PYTHON_INSTALL_DIR/value"; ! printf changed > "$UV_PYTHON_INSTALL_DIR/value"',
        expectExact: "host python",
      },
    },
  ]);
  const home = join(root, "host-home");
  const python = join(home, "python");
  await mkdir(python, { recursive: true });
  await writeFile(join(python, "value"), "host python\n");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["UV_PYTHON_INSTALL_DIR"] },
      filesystem: { readOnlyRoots: ["${UV_PYTHON_INSTALL_DIR}"] },
    }),
  );
  const run = await invoke([...args, "--shell-isolation"], {
    HOME: home,
    UV_PYTHON_INSTALL_DIR: python,
  });
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(await readFile(join(python, "value"), "utf8")).toBe("host python\n");
});

test("CLI seeds a private writable runtime without changing the host cache", async () => {
  const { root, project, args } = await fixture([
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
      runtime: { seedDirectories: [{ source, target: "dependencies" }] },
    }),
  );
  const run = await invoke([...args, "--shell-isolation"]);
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(await readFile(join(source, "value"), "utf8")).toBe("host cache\n");
});

test("CLI refuses runtime seed links escaping their declared directory", async () => {
  const { root, project, args } = await fixture();
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
  const { root, project, args } = await fixture([
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
  await writeFile(credential, '{"test":"synthetic"}');
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: {
        set: { PUBLIC_CACHE_DIR: "{{sevro.runtime}}/dependencies" },
      },
      runtime: { seedDirectories: [{ source, target: "dependencies" }] },
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
  const { root, project, args } = await fixture([
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
  await writeFile(credential, '{"test":"synthetic"}');
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
  const { root, project, args } = await fixture();
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
