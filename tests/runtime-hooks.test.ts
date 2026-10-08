import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeHost } from "../src/hosts/claude";
import { createCodexHost } from "../src/hosts/codex";
import { runtimeSeedDigest } from "../src/runtime-seeds";
import { defined } from "./fixtures/assertions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function hookFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-runtime-hooks-")),
  );
  roots.push(root);
  const workspace = join(root, "workspace"),
    projectRoot = join(root, "project"),
    resultsRoot = join(root, "results");
  await Promise.all(
    [workspace, projectRoot, resultsRoot].map((path) => mkdir(path)),
  );
  await writeFile(
    join(projectRoot, "private-input"),
    "evaluator private input",
  );
  const artifactRoots = ["packages/allowed", "packages/denied"],
    artifactPaths: string[] = [];
  for (const name of ["allowed", "denied"]) {
    const relative = `packages/${name}`,
      plugin = join(workspace, relative);
    await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
    await mkdir(join(plugin, ".codex-plugin"));
    await mkdir(join(plugin, "hooks"));
    await writeFile(
      join(plugin, ".claude-plugin/plugin.json"),
      JSON.stringify({ name, version: "1.0.0" }),
    );
    await writeFile(
      join(plugin, "hooks/hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: '/bin/sh "${CLAUDE_PLUGIN_ROOT}/hooks/start.sh"',
                },
              ],
            },
          ],
        },
      }),
    );
    await writeFile(
      join(plugin, ".codex-plugin/plugin.json"),
      JSON.stringify({ name, version: "1.0.0" }),
    );
    await writeFile(
      join(plugin, "hooks/start.sh"),
      `#!/bin/sh\ntest ! -r '${join(projectRoot, "private-input")}' || exit 7\nprintf '%s' "$SEVRO_RUNTIME_SAMPLE" > "$PWD/${name}.txt"\n`,
    );
    artifactPaths.push(
      ...[
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
        "hooks/hooks.json",
        "hooks/start.sh",
      ].map((file) => `${relative}/${file}`),
    );
  }
  const binary = await nativeClaudeInit(root);
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, '{"test":"synthetic"}');
  return {
    root,
    workspace,
    projectRoot,
    resultsRoot,
    binary,
    credentialFile,
    artifactRoots,
    artifactPaths,
  };
}

async function nativeClaudeInit(root: string) {
  const binary = join(root, "native-init");
  const claude = defined(Bun.which("claude"));
  await writeFile(
    binary,
    `#!${process.execPath}
const args = process.argv.slice(2);
const prompt = args.indexOf("-p"); args.splice(prompt, 2);
const child = Bun.spawn([${JSON.stringify(claude)}, "--init-only", ...args], { cwd: process.cwd(), env: process.env, stdout: "ignore", stderr: Bun.file("claude-init-error") });
const code = await child.exited;
if (code !== 0) process.exit(code);
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ready" }));
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

test("Claude executes only selected plugin hooks under protected-root isolation", async () => {
  const fixture = await hookFixture();
  const host = createClaudeHost({
    ...fixture,
    additionalProtectedRoots: [fixture.credentialFile],
    model: "sonnet",
    effort: "low",
    timeoutMs: 15000,
  });
  const result = await host.run({
    prompt: "Return ready.",
    workspace: fixture.workspace,
    condition: "passive",
    claudePluginDirs: {
      artifactRoots: fixture.artifactRoots,
      artifactPaths: fixture.artifactPaths,
    },
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { SEVRO_RUNTIME_SAMPLE: "selected hook" },
      readOnlyRoots: [],
      hooks: { nativeGoal: true, plugins: ["allowed"] },
    },
  });
  expect(result.complete).toBe(true);
  expect(
    await Bun.file(join(fixture.workspace, "allowed.txt")).exists(),
    JSON.stringify(
      result.observations?.find((row) => row.id === "sevro.host.hooks"),
    ),
  ).toBe(true);
  expect(await readFile(join(fixture.workspace, "allowed.txt"), "utf8")).toBe(
    "selected hook",
  );
  expect(await Bun.file(join(fixture.workspace, "denied.txt")).exists()).toBe(
    false,
  );
  const hooks = result.observations?.find(
    (row) => row.id === "sevro.host.hooks",
  );
  expect(JSON.stringify(hooks?.data)).not.toContain("hook-0.sh");
});

test("Claude releases an asynchronous hook before returning the trial", async () => {
  const fixture = await hookFixture();
  await writeFile(
    join(fixture.workspace, "packages/allowed/hooks/hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                async: true,
                command: '/bin/sh "${CLAUDE_PLUGIN_ROOT}/hooks/start.sh"',
              },
            ],
          },
        ],
      },
    }),
  );
  await writeFile(
    join(fixture.workspace, "packages/allowed/hooks/start.sh"),
    '#!/bin/sh\nprintf "%s" "$$" > "$PWD/hook.pid"\n/bin/sleep 20\n',
  );
  const host = createClaudeHost({
    ...fixture,
    additionalProtectedRoots: [fixture.credentialFile],
    model: "sonnet",
    effort: "low",
    timeoutMs: 3000,
  });
  expect(
    host.run({
      prompt: "Return ready.",
      workspace: fixture.workspace,
      condition: "passive",
      claudePluginDirs: {
        artifactRoots: fixture.artifactRoots,
        artifactPaths: fixture.artifactPaths,
      },
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        hooks: { plugins: ["allowed"] },
      },
    }),
  ).rejects.toThrow("timed out");
  const pid = Number(
    await readFile(join(fixture.workspace, "hook.pid"), "utf8"),
  );
  expect(processExists(pid)).toBe(false);
}, 30000);

test("Claude protects hook runtime seeds from workspace-created state", async () => {
  const fixture = await hookFixture();
  const source = join(fixture.root, "seed");
  await mkdir(source);
  await writeFile(join(source, "input"), "original");
  const planted = join(fixture.workspace, ".git/sevro-runtime/hooks/cache");
  await mkdir(planted, { recursive: true });
  await writeFile(join(planted, "input"), "workspace-created");
  await writeFile(
    join(fixture.workspace, "packages/allowed/hooks/start.sh"),
    '#!/bin/sh\n/bin/cat "$UV_CACHE_DIR/input" > "$PWD/hook-input.txt"\n',
  );
  const host = createClaudeHost({
    ...fixture,
    additionalProtectedRoots: [fixture.credentialFile],
    model: "sonnet",
    effort: "low",
    timeoutMs: 15000,
  });
  await host.run({
    prompt: "Return ready.",
    workspace: fixture.workspace,
    condition: "passive",
    claudePluginDirs: {
      artifactRoots: fixture.artifactRoots,
      artifactPaths: fixture.artifactPaths,
    },
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { UV_CACHE_DIR: "{{sevro.runtime}}/cache" },
      readOnlyRoots: [],
      seeds: [
        { source, target: "cache", sha256: await runtimeSeedDigest(source) },
      ],
      hooks: { plugins: ["allowed"] },
    },
  });
  expect(
    await readFile(join(fixture.workspace, "hook-input.txt"), "utf8"),
  ).toBe("original");
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.each([
  {
    name: "prompt",
    handler: { type: "prompt", prompt: "Ready" },
    message: "command plugin hooks only",
  },
  {
    name: "agent",
    handler: { type: "agent", prompt: "Ready" },
    message: "command plugin hooks only",
  },
  {
    name: "MCP tool",
    handler: { type: "mcp_tool", tool: "outside" },
    message: "command plugin hooks only",
  },
  {
    name: "missing command",
    handler: { type: "command" },
    message: "command plugin hooks only",
  },
  {
    name: "null handler",
    handler: null,
    message: "invalid runtime hook declaration",
  },
  {
    name: "exec arguments",
    handler: { type: "command", command: "true", args: ["outside"] },
    message: "exec-form",
  },
  {
    name: "empty exec arguments",
    handler: { type: "command", command: "true", args: [] },
    message: "exec-form",
  },
  {
    name: "oversized command",
    handler: { type: "command", command: "a".repeat(65537) },
    message: "oversized",
  },
  {
    name: "NUL command",
    handler: { type: "command", command: "a\0b" },
    message: "invalid",
  },
])(
  "Claude refuses an unsupported selected hook: $name",
  async ({ handler, message }) => {
    const fixture = await hookFixture();
    await writeFile(
      join(fixture.workspace, "packages/allowed/hooks/hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [handler] }] } }),
    );
    const host = createClaudeHost({
      ...fixture,
      additionalProtectedRoots: [fixture.credentialFile],
      model: "sonnet",
      effort: "low",
    });
    expect(
      host.run({
        prompt: "Return ready.",
        workspace: fixture.workspace,
        condition: "passive",
        claudePluginDirs: {
          artifactRoots: fixture.artifactRoots,
          artifactPaths: fixture.artifactPaths,
        },
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          hooks: { plugins: ["allowed"] },
        },
      }),
    ).rejects.toThrow(message);
    expect(
      await Bun.file(join(fixture.workspace, "allowed.txt")).exists(),
    ).toBe(false);
  },
);

test.each([
  {
    name: "non-array groups",
    hooks: { SessionStart: { hooks: [] } },
    message: "groups must be arrays",
  },
  {
    name: "non-array handlers",
    hooks: { SessionStart: [{ hooks: {} }] },
    message: "handlers must be arrays",
  },
  {
    name: "null groups",
    hooks: null,
    message: "invalid runtime hook declaration",
  },
])(
  "Claude refuses malformed selected hook groups: $name",
  async ({ hooks, message }) => {
    const fixture = await hookFixture();
    await writeFile(
      join(fixture.workspace, "packages/allowed/hooks/hooks.json"),
      JSON.stringify({ hooks }),
    );
    const host = createClaudeHost({
      ...fixture,
      additionalProtectedRoots: [fixture.credentialFile],
      model: "sonnet",
      effort: "low",
    });
    expect(
      host.run({
        prompt: "Return ready.",
        workspace: fixture.workspace,
        condition: "passive",
        claudePluginDirs: {
          artifactRoots: fixture.artifactRoots,
          artifactPaths: fixture.artifactPaths,
        },
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          hooks: { plugins: ["allowed"] },
        },
      }),
    ).rejects.toThrow(message);
  },
);

test.each([
  {
    name: "missing name",
    manifest: { version: "1.0.0" },
    message: "has no name",
  },
  {
    name: "duplicate name",
    manifest: { name: "denied", version: "1.0.0" },
    message: "names overlap",
  },
  {
    name: "mods",
    manifest: { name: "allowed", version: "1.0.0", mods: [] },
    message: "mods are unsupported",
  },
])(
  "Claude refuses unsupported runtime plugin metadata: $name",
  async ({ manifest, message }) => {
    const fixture = await hookFixture();
    await writeFile(
      join(fixture.workspace, "packages/allowed/.claude-plugin/plugin.json"),
      JSON.stringify(manifest),
    );
    const host = createClaudeHost({
      ...fixture,
      additionalProtectedRoots: [fixture.credentialFile],
      model: "sonnet",
      effort: "low",
    });
    expect(
      host.run({
        prompt: "Return ready.",
        workspace: fixture.workspace,
        condition: "passive",
        claudePluginDirs: {
          artifactRoots: fixture.artifactRoots,
          artifactPaths: fixture.artifactPaths,
        },
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          hooks: { nativeGoal: true },
        },
      }),
    ).rejects.toThrow(message);
  },
);

test("Claude refuses an unavailable hook plugin selection", async () => {
  const fixture = await hookFixture();
  const host = createClaudeHost({
    ...fixture,
    additionalProtectedRoots: [fixture.credentialFile],
    model: "sonnet",
    effort: "low",
  });
  expect(
    host.run({
      prompt: "Return ready.",
      workspace: fixture.workspace,
      condition: "passive",
      claudePluginDirs: {
        artifactRoots: fixture.artifactRoots,
        artifactPaths: fixture.artifactPaths,
      },
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        hooks: { plugins: ["unavailable"] },
      },
    }),
  ).rejects.toThrow("unavailable plugin");
});

test("Claude refuses auxiliary plugin execution outside hook authority", async () => {
  const fixture = await hookFixture();
  const relative = "packages/allowed/.mcp.json";
  await writeFile(
    join(fixture.workspace, relative),
    JSON.stringify({
      mcpServers: { outside: { command: "/bin/sh", args: ["-c", "true"] } },
    }),
  );
  fixture.artifactPaths.push(relative);
  const host = createClaudeHost({
    ...fixture,
    additionalProtectedRoots: [fixture.credentialFile],
    model: "sonnet",
    effort: "low",
  });
  expect(
    host.run({
      prompt: "Return ready.",
      workspace: fixture.workspace,
      condition: "passive",
      claudePluginDirs: {
        artifactRoots: fixture.artifactRoots,
        artifactPaths: fixture.artifactPaths,
      },
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        hooks: { plugins: ["allowed"] },
      },
    }),
  ).rejects.toThrow("auxiliary plugin execution");
});

test("Claude executes a manifest hook file shared by both host manifests", async () => {
  const fixture = await hookFixture();
  const relative = "packages/allowed/custom-hooks.json";
  await writeFile(
    join(fixture.workspace, relative),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: '/bin/sh "${PLUGIN_ROOT}/hooks/start.sh"',
              },
            ],
          },
        ],
      },
    }),
  );
  await rm(join(fixture.workspace, "packages/allowed/hooks/hooks.json"));
  fixture.artifactPaths = fixture.artifactPaths.filter(
    (path) => path !== "packages/allowed/hooks/hooks.json",
  );
  fixture.artifactPaths.push(relative);
  for (const format of [".claude-plugin", ".codex-plugin"])
    await writeFile(
      join(fixture.workspace, `packages/allowed/${format}/plugin.json`),
      JSON.stringify({
        name: "allowed",
        version: "1.0.0",
        hooks:
          format === ".claude-plugin"
            ? "./custom-hooks.json"
            : ["./custom-hooks.json"],
      }),
    );
  const host = createClaudeHost({
    ...fixture,
    additionalProtectedRoots: [fixture.credentialFile],
    model: "sonnet",
    effort: "low",
    timeoutMs: 15000,
  });
  const result = await host.run({
    prompt: "Return ready.",
    workspace: fixture.workspace,
    condition: "passive",
    claudePluginDirs: {
      artifactRoots: fixture.artifactRoots,
      artifactPaths: fixture.artifactPaths,
    },
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { SEVRO_RUNTIME_SAMPLE: "manifest hook" },
      readOnlyRoots: [],
      hooks: { plugins: ["allowed"] },
    },
  });
  expect(result.complete).toBe(true);
  expect(
    await Bun.file(join(fixture.workspace, "allowed.txt")).exists(),
    JSON.stringify(result.observations) +
      (await Bun.file(join(fixture.workspace, "claude-init-error")).text()),
  ).toBe(true);
  expect(await readFile(join(fixture.workspace, "allowed.txt"), "utf8")).toBe(
    "manifest hook",
  );
});

test("Claude safely processes skill hook frontmatter alongside ordinary Markdown", async () => {
  const fixture = await hookFixture();
  for (const name of ["allowed", "denied"]) {
    const directory = join(fixture.workspace, `packages/${name}/skills/probe`);
    await mkdir(directory, { recursive: true });
    const files = {
      "SKILL.md":
        "---\nname: probe\ndescription: Probe.\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: /bin/true\n---\nReturn ready.\n",
      "plain.md": "No frontmatter here.\n",
      "description.md":
        "---\nname: description\ndescription: Describes hooks.\n---\nDocumentation.\n",
    };
    for (const [file, content] of Object.entries(files)) {
      await writeFile(join(directory, file), content);
      fixture.artifactPaths.push(`packages/${name}/skills/probe/${file}`);
    }
  }
  const host = createClaudeHost({
    ...fixture,
    additionalProtectedRoots: [fixture.credentialFile],
    model: "sonnet",
    effort: "low",
    timeoutMs: 15000,
  });
  const result = await host.run({
    prompt: "Return ready.",
    workspace: fixture.workspace,
    condition: "passive",
    claudePluginDirs: {
      artifactRoots: fixture.artifactRoots,
      artifactPaths: fixture.artifactPaths,
    },
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { SEVRO_RUNTIME_SAMPLE: "frontmatter mount" },
      readOnlyRoots: [],
      hooks: { plugins: ["allowed"] },
    },
  });
  expect(result.complete).toBe(true);
  expect(await readFile(join(fixture.workspace, "allowed.txt"), "utf8")).toBe(
    "frontmatter mount",
  );
  expect(await Bun.file(join(fixture.workspace, "denied.txt")).exists()).toBe(
    false,
  );
});

async function runCodexHookFixture(
  fixture: Awaited<ReturnType<typeof hookFixture>>,
  entrypoint: "exec" | "app-server" = "exec",
) {
  const manifest = "packages/.claude-plugin/marketplace.json";
  await mkdir(join(fixture.workspace, "packages/.claude-plugin"));
  await writeFile(
    join(fixture.workspace, manifest),
    JSON.stringify({
      name: "runtime-probe",
      owner: { name: "Sevro" },
      plugins: ["allowed", "denied"].map((name) => ({
        name,
        source: `./${name}`,
        description: name,
      })),
    }),
  );
  const codex = defined(Bun.which("codex"));
  const binary = join(fixture.root, "codex-init");
  await writeFile(
    binary,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "plugin" || args[0] === "--version") {
 const child = Bun.spawn([${JSON.stringify(codex)}, ...args], {env: process.env, stdout: "inherit", stderr: "inherit"}); process.exit(await child.exited);
}
const server = Bun.serve({port: 0, fetch() { return Response.json({error: {message: "intentional fixture stop"}}, {status: 400}); }});
if (args[0] === "app-server") {
 // Only the external model route is mocked; native hook discovery, trust and execution stay in Codex.
 const overrides = ["-c", 'model_providers.runtime_mock.name="runtime_mock"', "-c", "model_providers.runtime_mock.base_url=" + JSON.stringify(server.url.href), "-c", 'model_providers.runtime_mock.wire_api="responses"', "-c", 'model_providers.runtime_mock.requires_openai_auth=false', "-c", 'model_providers.runtime_mock.stream_max_retries=0'];
 const child = Bun.spawn([${JSON.stringify(codex)}, ...args, ...overrides], {env: process.env, stdin: "pipe", stdout: "pipe", stderr: Bun.file("codex-init-error")});
 const {createInterface} = await import("node:readline");
 createInterface({input: process.stdin}).on("line", (line) => { const message = JSON.parse(line); if (message.method === "thread/start") message.params.modelProvider = "runtime_mock"; child.stdin.write(JSON.stringify(message) + "\\n"); });
 const reader = child.stdout.getReader(); let buffer = "";
 for (;;) { const {value, done} = await reader.read(); if (done) break; buffer += new TextDecoder().decode(value); let newline; while ((newline = buffer.indexOf("\\n")) >= 0) { const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); if (message.result?.modelProvider === "runtime_mock") message.result.modelProvider = "openai"; console.log(JSON.stringify(message)); }}
 const code = await child.exited; server.stop(true); process.exit(code);
}
await Bun.write("codex-hook-config", await Bun.file(process.env.CODEX_HOME + "/config.toml").text());
const provider = ["-c", 'model_provider="runtime_mock"', "-c", 'model_providers.runtime_mock.name="runtime_mock"', "-c", "model_providers.runtime_mock.base_url=" + JSON.stringify(server.url.href), "-c", 'model_providers.runtime_mock.wire_api="responses"', "-c", 'model_providers.runtime_mock.requires_openai_auth=false', "-c", 'model_providers.runtime_mock.stream_max_retries=0'];
const child = Bun.spawn([${JSON.stringify(codex)}, ...args, ...provider], {env: process.env, stdin: "pipe", stdout: Bun.file("codex-hook-events"), stderr: Bun.file("codex-init-error")});
child.stdin.write("Return ready."); child.stdin.end();
const timer = setTimeout(() => child.kill(), 8000); await child.exited; clearTimeout(timer); server.stop(true);
console.log(JSON.stringify({type: "thread.started", thread_id: "runtime-probe"}));
console.log(JSON.stringify({type: "item.completed", item: {type: "agent_message", text: "ready"}}));
console.log(JSON.stringify({type: "turn.completed"}));
`,
    { mode: 0o700 },
  );
  const host = createCodexHost({
    ...fixture,
    binary,
    sandboxBinary: codex,
    authFile: fixture.credentialFile,
    additionalProtectedRoots: [fixture.credentialFile],
    model: "synthetic",
    effort: "low",
    timeoutMs: 15000,
    entrypoint,
  });
  const result = await host.run({
    prompt: "Return ready.",
    workspace: fixture.workspace,
    condition: "passive",
    codexMarketplace: {
      artifactRoot: "packages",
      marketplaceName: "runtime-probe",
      pluginNames: ["allowed", "denied"],
      artifactPaths: [...fixture.artifactPaths, manifest],
    },
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { SEVRO_RUNTIME_SAMPLE: "selected hook" },
      readOnlyRoots: [],
      hooks: { plugins: ["allowed"] },
    },
  });
  return result;
}

test("Codex executes only selected plugin hooks under protected-root isolation", async () => {
  const fixture = await hookFixture();
  const result = await runCodexHookFixture(fixture);
  expect(result.complete).toBe(true);
  expect(
    await Bun.file(join(fixture.workspace, "allowed.txt")).exists(),
    JSON.stringify(result.observations) +
      (await Bun.file(join(fixture.workspace, "codex-hook-config")).text()) +
      (await Bun.file(join(fixture.workspace, "codex-hook-events")).text()) +
      (await Bun.file(join(fixture.workspace, "codex-init-error")).text()),
  ).toBe(true);
  expect(await readFile(join(fixture.workspace, "allowed.txt"), "utf8")).toBe(
    "selected hook",
  );
  expect(await Bun.file(join(fixture.workspace, "denied.txt")).exists()).toBe(
    false,
  );
}, 30000);

test("Codex isolates hooks declared in its native plugin manifest", async () => {
  const fixture = await hookFixture();
  await writeFile(
    join(fixture.workspace, "packages/allowed/.codex-plugin/plugin.json"),
    JSON.stringify({
      name: "allowed",
      version: "1.0.0",
      hooks: {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: '/bin/sh "${PLUGIN_ROOT}/hooks/start.sh"',
                },
              ],
            },
          ],
        },
      },
    }),
  );
  const result = await runCodexHookFixture(fixture);
  expect(
    await Bun.file(join(fixture.workspace, "allowed.txt")).exists(),
    JSON.stringify(result.observations),
  ).toBe(true);
  expect(await readFile(join(fixture.workspace, "allowed.txt"), "utf8")).toBe(
    "selected hook",
  );
}, 30000);

test("Codex app-server dispatches selected plugin hooks", async () => {
  const fixture = await hookFixture();
  await writeFile(
    fixture.credentialFile,
    JSON.stringify({ OPENAI_API_KEY: "synthetic-test-credential" }),
  );
  const result = await runCodexHookFixture(fixture, "app-server");
  expect(
    await Bun.file(join(fixture.workspace, "allowed.txt")).exists(),
    JSON.stringify(result.observations) +
      (await Bun.file(join(fixture.workspace, "codex-init-error")).text()),
  ).toBe(true);
  expect(await readFile(join(fixture.workspace, "allowed.txt"), "utf8")).toBe(
    "selected hook",
  );
  expect(await Bun.file(join(fixture.workspace, "denied.txt")).exists()).toBe(
    false,
  );
}, 30000);
