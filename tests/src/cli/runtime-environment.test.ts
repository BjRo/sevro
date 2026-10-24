import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defined, parseRunEvidence } from "../../fixtures/assertions";
import { syntheticClaudeLogin } from "../../fixtures/claude-login";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import { fixture, invoke } from "../../fixtures/runtime-cli";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("CLI protects grader runtime seeds from candidate-created state", async () => {
  const { root, project, args } = await fixture(roots, [
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
      runtime: {
        seedDirectories: [{ source, target: "cache", roles: ["checks"] }],
      },
    }),
  );
  const run = await invoke([...args, "--shell-isolation"]);
  expect(run.code, run.stderr).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
});

test("CLI native-goal policy selects Codex app-server by default", async () => {
  const { root, project, args } = await fixture(roots);
  const adapter = args.indexOf("--adapter-module");
  args.splice(adapter, 2);
  const binary = join(root, "codex-peer");
  await writeFile(
    binary,
    `#!${process.execPath}\nawait import(${JSON.stringify(join(import.meta.dir, "../../fixtures/app-server-peer.ts"))});\n`,
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
  const { project, args } = await fixture(roots);
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
  const { root, project, args } = await fixture(roots);
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
  const { root, project, args } = await fixture(roots);
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

test.each([
  "ANTHROPIC_API_KEY",
  "HOME",
  "CODEX_HOME",
  "NODE_OPTIONS",
  "TMPPREFIX",
  "tmpprefix",
])(
  "CLI refuses credential or runner environment inheritance: %s",
  async (name) => {
    const { root, project, args } = await fixture(roots);
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
  const { root, project, args } = await fixture(roots, [
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
  const { root, project, args } = await fixture(roots, [
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
  await writeFile(credential, syntheticClaudeLogin());
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
    const { root, project, args } = await fixture(roots);
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
  const { project, args } = await fixture(roots, [
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
  const { root, project, args } = await fixture(roots, [
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
  const { root, project, args } = await fixture(roots, [
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

test("CLI inherited PATH omits Codex credential directories before the first evaluation", async () => {
  const { root, project, args } = await fixture(roots, [
    {
      id: "tool",
      grader: "sevro.shell",
      configuration: { run: "probe", expectExact: "public tool" },
    },
  ]);
  const home = join(root, "host-home"),
    injected = join(home, ".codex", "tmp", "arg0", "codex-arg0-example"),
    bin = join(root, "public-tools");
  await mkdir(injected, { recursive: true });
  await mkdir(bin);
  await writeFile(
    join(injected, "probe"),
    '#!/bin/sh\nprintf "private tool"\n',
    {
      mode: 0o755,
    },
  );
  await writeFile(join(bin, "probe"), '#!/bin/sh\nprintf "public tool"\n', {
    mode: 0o755,
  });
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["PATH"] },
    }),
  );
  const effectivePath = `${bin}:/usr/bin:/bin`;
  const run = await invoke([...args, "--shell-isolation"], {
    HOME: home,
    PATH: `${injected}:${effectivePath}`,
  });
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(evidence.configuration.redacted.runtimePolicy).toMatchObject({
    environment: { PATH: effectivePath },
  });
});

test.each(["directory-alias", "tool-alias", "absent"])(
  "CLI inherited PATH omits credential aliases: %s",
  async (kind) => {
    const { root, project, args } = await fixture(roots);
    const home = join(root, "host-home"),
      credentials = join(root, "private-codex"),
      bin = join(root, "tools");
    await mkdir(home);
    await mkdir(credentials);
    await symlink(credentials, join(home, ".codex"));
    if (kind === "directory-alias") await symlink(credentials, bin);
    if (kind === "tool-alias") {
      await mkdir(bin);
      const tool = join(credentials, "private-tool");
      await writeFile(tool, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
      await symlink(tool, join(bin, "probe"));
    }
    const inherited = kind === "absent" ? join(credentials, "missing") : bin;
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { inherit: ["PATH"] },
      }),
    );
    const run = await invoke([...args, "--dry"], {
      HOME: home,
      PATH: `${inherited}:/usr/bin:/bin`,
    });
    expect(run.code, JSON.stringify(run.result)).toBe(0);
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    expect(evidence.configuration.redacted.runtimePolicy).toMatchObject({
      environment: { PATH: "/usr/bin:/bin" },
    });
  },
);

test("CLI inherited PATH omits an installation prefix containing credentials", async () => {
  const { root, project, args } = await fixture(roots);
  const home = join(root, "host-home"),
    installation = join(root, "installation"),
    bin = join(installation, "bin"),
    credentials = join(installation, "private");
  await mkdir(home);
  await mkdir(bin, { recursive: true });
  await mkdir(credentials);
  await symlink(credentials, join(home, ".codex"));
  await writeFile(join(bin, "probe"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["PATH"] },
    }),
  );
  const run = await invoke([...args, "--dry"], {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
  });
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(evidence.configuration.redacted.runtimePolicy).toMatchObject({
    environment: { PATH: "/usr/bin:/bin" },
  });
  for (const denied of [installation, bin, credentials])
    expect(evidence.configuration.redacted.runtimePolicy).not.toHaveProperty(
      "readOnlyRoots",
      expect.arrayContaining([denied]),
    );
});

test.each(["", "relative", "/usr/bin\n", "/bin/sh"])(
  "CLI inherited PATH refuses malformed entries before execution: %s",
  async (entry) => {
    const { project, args } = await fixture(roots);
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { inherit: ["PATH"] },
      }),
    );
    const run = await invoke([...args, "--dry"], {
      PATH: `${entry}:/usr/bin:/bin`,
    });
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
    expect(run.result.diagnostic?.message).toContain("runtime PATH");
  },
);

test("CLI refuses a missing inherited PATH before execution", async () => {
  const { project, args } = await fixture(roots);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["PATH"] },
    }),
  );
  const run = await invoke([...args, "--dry"], { PATH: undefined });
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
  expect(run.result.diagnostic?.message).toContain(
    "runtime environment variable is missing: PATH",
  );
});

test("CLI refuses an explicit PATH override into Codex credentials", async () => {
  const { root, project, args } = await fixture(roots);
  const home = join(root, "host-home"),
    bin = join(home, ".codex", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["PATH"], set: { PATH: `${bin}:/usr/bin:/bin` } },
    }),
  );
  const run = await invoke(args, { HOME: home, PATH: "/usr/bin:/bin" });
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
  expect(run.result.diagnostic?.message).toContain("protected data");
});

test("CLI refuses an inherited PATH with only credential directories", async () => {
  const { root, project, args } = await fixture(roots);
  const home = join(root, "host-home"),
    bin = join(home, ".codex", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["PATH"] },
    }),
  );
  const run = await invoke(args, { HOME: home, PATH: bin });
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
  expect(run.result.diagnostic?.message).toContain("no unprotected entries");
});
