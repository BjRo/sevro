import { afterEach, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClaudeHost } from "../../../src/hosts/index";
import type { RuntimePolicy } from "../../../src/runtime/index";
import { syntheticClaudeLogin } from "../../fixtures/claude-login";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));

interface CapturedSettings {
  disableAllHooks: boolean;
  sandbox: {
    enabled: boolean;
    allowUnsandboxedCommands: boolean;
    failIfUnavailable: boolean;
    filesystem: { denyRead: string[]; denyWrite: string[] };
    credentials: { files: Array<{ path: string; mode: string }> };
  };
  permissions: { allow: string[]; deny: string[] };
}

/** Retains the settings Claude received, then completes the turn. */
const capturingClaude = `#!${process.execPath}
import { copyFile } from "node:fs/promises";
await copyFile(process.argv[process.argv.indexOf("--settings") + 1], "captured-settings.json");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ready" }) + "\\n");
`;

async function settingsHost(additionalProtectedRoots: string[] = []) {
  const root = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-claude-settings-")),
  );
  const workspace = join(root, "workspace");
  const projectRoot = join(root, "source");
  const resultsRoot = join(root, "results");
  const protectedRoot = join(root, "protected");
  const plugin = join(workspace, "package", "probe");
  await Promise.all(
    [
      join(plugin, ".claude-plugin"),
      join(plugin, "skills", "probe"),
      projectRoot,
      resultsRoot,
      protectedRoot,
    ].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(
    join(plugin, ".claude-plugin", "plugin.json"),
    '{"name":"probe","version":"0.1.0"}',
  );
  await writeFile(join(plugin, "skills", "probe", "SKILL.md"), "Use it.\n");
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, syntheticClaudeLogin());
  const binary = join(root, "fake-claude");
  await writeFile(binary, capturingClaude, { mode: 0o755 });
  const host = createClaudeHost({
    binary,
    model: "synthetic",
    effort: "low",
    projectRoot,
    resultsRoot,
    additionalProtectedRoots: [protectedRoot, ...additionalProtectedRoots],
    credentialFile,
  });
  async function capture(runtimePolicy?: RuntimePolicy) {
    const result = await host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      ...(runtimePolicy ? { runtimePolicy } : {}),
    });
    expect(result.finalMessage).toBe("ready");
    return (await Bun.file(
      join(workspace, "captured-settings.json"),
    ).json()) as CapturedSettings;
  }
  return { root, host, workspace, plugin, capture, protectedRoot };
}

test("Claude host settings deny private state to Bash and file tools", async () => {
  if (!isolatedNativeHost) return;
  const { root, host, workspace, plugin, protectedRoot } = await settingsHost();
  const result = await host.run({
    prompt: "Use /probe:probe and return ready.",
    workspace,
    condition: "passive",
    claudePluginDirs: {
      artifactRoots: ["package/probe"],
      artifactPaths: [
        "package/probe/.claude-plugin/plugin.json",
        "package/probe/skills/probe/SKILL.md",
      ],
    },
    explicitSkillInvocation: {
      pluginName: "probe",
      skillName: "probe",
      token: "/probe:probe",
    },
  });
  expect(result.finalMessage).toBe("ready");
  const settings = (await Bun.file(
    join(workspace, "captured-settings.json"),
  ).json()) as CapturedSettings;
  const [credential] = settings.sandbox.credentials.files;
  if (!credential) throw new Error("missing denied credential file");
  // The staged credential anchors the private state root it lives under.
  const privateRoot = dirname(dirname(credential.path));
  expect(credential).toEqual({
    path: join(privateRoot, "config", ".credentials.json"),
    mode: "deny",
  });
  expect(privateRoot.startsWith(`${root}/`)).toBe(false);
  expect(settings.disableAllHooks).toBe(true);
  expect(settings.sandbox).toMatchObject({
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
  });
  const denied = [
    privateRoot,
    join(root, "source"),
    join(root, "results"),
    protectedRoot,
  ];
  const { denyRead, denyWrite } = settings.sandbox.filesystem;
  for (const path of denied) {
    expect(denyRead).toContain(path);
    expect(denyWrite).toContain(path);
    expect(settings.permissions.deny).toContain(`Read(/${path}/**)`);
    expect(settings.permissions.deny).toContain(`Edit(/${path}/**)`);
  }
  expect(denyRead).not.toContain(plugin);
  expect(denyWrite).toContain(plugin);
  expect(settings.permissions.deny).toContain(`Edit(/${plugin}/**)`);
  expect(settings.permissions.deny).not.toContain(`Read(/${plugin}/**)`);
  for (const tool of ["Bash", "Agent", "SendMessage"])
    expect(settings.permissions.allow).toContain(tool);
  expect(JSON.stringify(settings)).not.toContain("PRIVATE_TEST_LOGIN");
});

test("Claude host settings reject escaping and malformed state paths", async () => {
  if (!isolatedNativeHost) return;
  expect(() =>
    createClaudeHost({
      binary: "/bin/true",
      model: "synthetic",
      effort: "low",
      projectRoot: "/tmp/source",
      resultsRoot: "/tmp/results",
      additionalProtectedRoots: ["relative"],
    }),
  ).toThrow("invalid Claude host configuration");
  const root = await temporaryFixture(
    join(tmpdir(), "sevro-claude-settings-root-"),
  );
  for (const name of ["(bad)", "line\nbreak"]) {
    const malformed = join(root, name);
    await mkdir(malformed);
    const { host, workspace } = await settingsHost([malformed]);
    const pending = host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
    });
    expect(pending).rejects.toThrow("Claude private state paths are invalid");
    await pending.catch(() => undefined);
    expect(
      await Bun.file(join(workspace, "captured-settings.json")).exists(),
    ).toBe(false);
  }
});

test("Claude host settings allow retained agent messaging with runtime policies", async () => {
  if (!isolatedNativeHost) return;
  const { capture } = await settingsHost();
  const withoutPolicy = await capture();
  const withPolicy = await capture({
    format: "sevro.runtime.v1",
    environment: {},
    readOnlyRoots: [],
  });
  expect(withoutPolicy.permissions.allow).toContain("SendMessage");
  expect(withPolicy.permissions.allow).toContain("SendMessage");
});

test("runtime policies grant edits only to the workspace and its writable runtime", async () => {
  if (!isolatedNativeHost) return;
  const { capture, workspace } = await settingsHost();
  const legacy = await capture();
  expect(legacy.permissions.allow).toContain("Read");
  expect(legacy.permissions.allow).toContain("Edit");
  const isolated = await capture({
    format: "sevro.runtime.v1",
    environment: {},
    readOnlyRoots: [],
  });
  const { allow } = isolated.permissions;
  expect(allow).not.toContain("Read");
  expect(allow).not.toContain("Edit");
  expect(allow).toContain(`Edit(/${workspace}/**)`);
  // The remaining edit grant is the trial's private writable runtime root.
  const runtimeGrants = allow.filter(
    (rule) => rule.startsWith("Edit(") && rule !== `Edit(/${workspace}/**)`,
  );
  expect(runtimeGrants).toHaveLength(1);
  expect(isolated.permissions.deny).not.toContain(runtimeGrants[0]);
});

test("a runtime read root that permission rules cannot express is refused", async () => {
  if (!isolatedNativeHost) return;
  const { host, root, workspace } = await settingsHost();
  const readable = join(root, "read(only)");
  await mkdir(readable);
  const pending = host.run({
    prompt: "Return ready.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [readable],
    },
  });
  expect(pending).rejects.toThrow("Claude protected path is invalid");
  await pending.catch(() => undefined);
  expect(
    await Bun.file(join(workspace, "captured-settings.json")).exists(),
  ).toBe(false);
});
