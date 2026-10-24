import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  allocateWorkspace,
  removeWorkspace,
} from "../../../src/fixtures/workspace-state";
import { createCodexHost } from "../../../src/hosts/codex";
import {
  defined,
  expectUnknown,
  objectContaining,
} from "../../fixtures/assertions";
import {
  assertPluginPromptPermissions,
  digest,
  fixture,
  isolatedNativeHost,
  ordinaryCodexOptions,
  ordinaryMarketplace,
  waitForCodexMarker,
} from "../../fixtures/codex-host";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test.each(["exec", "app-server"] as const)(
  "Codex prepares a hook-free native plugin in a managed workspace: %s",
  async (entrypoint) => {
    const selected = await ordinaryMarketplace(roots);
    const workspace = await allocateWorkspace();
    try {
      await mkdir(join(workspace, ".git"));
      await cp(selected.root, join(workspace, "marketplace"), {
        recursive: true,
      });
      await writeFile(join(workspace, "require-plugin.flag"), "\n");
      const binary = join(
        dirname(selected.paths.fakeBinary),
        "native-plugin-peer",
      );
      await writeFile(
        binary,
        `#!/bin/sh
if [ "$1" = app-server ]; then
  test -f "$CODEX_HOME/plugins/cache/sevro-probe/probe/0.1.0/skills/probe/SKILL.md" || exit 95
  exec '${process.execPath}' '${join(import.meta.dir, "../../fixtures/app-server-peer.ts")}' "$@"
fi
exec '${selected.paths.fakeBinary}' "$@"
`,
        { mode: 0o700 },
      );
      const host = createCodexHost({
        ...ordinaryCodexOptions,
        ...selected.paths,
        binary,
        sandboxBinary: defined(Bun.which("codex")),
        entrypoint,
      });
      const result = await host.run({
        ...selected.request,
        workspace,
        codexMarketplace: selected.declaration,
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          seeds: [
            {
              source: selected.paths.projectRoot,
              target: "hook-cache",
              sha256: digest,
              roles: ["hooks"],
            },
          ],
        },
      });
      expect(result.complete).toBe(true);
      expect(result.finalMessage).toBe("ready");
      if (entrypoint === "app-server")
        expect(result).toMatchObject({
          inputTokens: null,
          outputTokens: null,
          usageComplete: false,
        });
      expectUnknown(result.observations).toContainEqual({
        id: "sevro.host.hooks",
        completeness: "complete",
        data: {
          plugins: [objectContaining({ name: "probe", allowed: false })],
          executions: [],
        },
      });
    } finally {
      await removeWorkspace(workspace);
    }
  },
);

test.each(["preparation-failure", "cancellation"] as const)(
  "Codex removes private plugin projections after %s",
  async (ending) => {
    const selected = await ordinaryMarketplace(roots);
    const workspace = await allocateWorkspace();
    const controller = new AbortController();
    let running: ReturnType<typeof selected.host.run> | undefined;
    try {
      await cp(selected.root, join(workspace, "marketplace"), {
        recursive: true,
      });
      await writeFile(join(workspace, "require-plugin.flag"), "\n");
      const binary = join(
        dirname(selected.paths.fakeBinary),
        "cleanup-plugin-peer",
      );
      await writeFile(
        binary,
        `#!/bin/sh
printf '%s' "$CODEX_HOME" > "$PWD/private-plugin-home"
exec '${selected.paths.fakeBinary}' "$@"
`,
        { mode: 0o700 },
      );
      if (ending === "preparation-failure") {
        await writeFile(
          join(workspace, "marketplace/plugin/.claude-plugin/plugin.json"),
          JSON.stringify({ name: "probe", version: "0.1.0", mods: {} }),
        );
      } else {
        await writeFile(join(workspace, "slow.flag"), "\n");
      }
      const host = createCodexHost({
        ...ordinaryCodexOptions,
        ...selected.paths,
        binary,
        sandboxBinary: defined(Bun.which("codex")),
      });
      running = host.run({
        ...selected.request,
        workspace,
        codexMarketplace: selected.declaration,
        signal: controller.signal,
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
        },
      });
      if (ending === "preparation-failure") {
        expect(running).rejects.toThrow("runtime plugin mods are unsupported");
        await running.catch(() => undefined);
      } else {
        await waitForCodexMarker(join(workspace, "child.pid"));
        controller.abort("SIGTERM");
        expect(running).rejects.toThrow("Codex run cancelled");
        await running.catch(() => undefined);
      }
      const privateHome = await readFile(
        join(workspace, "private-plugin-home"),
        "utf8",
      );
      expect(existsSync(dirname(privateHome))).toBe(false);
    } finally {
      controller.abort("SIGTERM");
      await running?.catch(() => undefined);
      await removeWorkspace(workspace);
    }
  },
  15000,
);

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("Codex host installs a declared local plugin in its isolated home", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-codex-plugin-"),
  );

  const packageRoot = join(workspace, "marketplace");
  await mkdir(join(packageRoot, ".claude-plugin"), { recursive: true });
  await mkdir(join(packageRoot, "plugin", ".claude-plugin"), {
    recursive: true,
  });
  await mkdir(join(packageRoot, "plugin", ".codex-plugin"), {
    recursive: true,
  });
  await mkdir(join(packageRoot, "plugin", "skills", "probe"), {
    recursive: true,
  });
  await writeFile(
    join(packageRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "sevro-probe",
      owner: { name: "Sevro" },
      plugins: [{ name: "probe", source: "./plugin", description: "Probe" }],
    }),
  );
  await writeFile(
    join(packageRoot, "plugin", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "probe", version: "0.1.0" }),
  );
  await writeFile(
    join(packageRoot, "plugin", ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "probe", version: "0.1.0", skills: "./skills/" }),
  );
  await writeFile(
    join(packageRoot, "plugin", "skills", "probe", "SKILL.md"),
    "---\nname: probe\ndescription: Test probe\n---\nRead this skill.\n",
  );
  await writeFile(join(workspace, "require-plugin.flag"), "\n");
  await writeFile(join(workspace, "capture-model-input.flag"), "\n");
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const request = {
    prompt: "Return ready.",
    workspace,
    condition: "passive" as const,
    codexMarketplace: {
      artifactRoot: "marketplace",
      marketplaceName: "sevro-probe",
      pluginNames: ["probe"],
      artifactPaths: [
        "marketplace/.claude-plugin/marketplace.json",
        "marketplace/plugin/.claude-plugin/plugin.json",
        "marketplace/plugin/.codex-plugin/plugin.json",
        "marketplace/plugin/skills/probe/SKILL.md",
      ],
    },
  };
  const result = await host.run(request);
  const modelInput = await readFile(
    join(workspace, "model-input.json"),
    "utf8",
  );
  await rm(join(workspace, "capture-model-input.flag"));
  assertPluginPromptPermissions(modelInput);
  expect(result.finalMessage).toBe("ready");
  expect(result.complete).toBe(true);
  await writeFile(join(workspace, "follow-up-skill-read.flag"), "\n");
  const resumed = await host.run({ ...request, followUpPrompt: "Continue." });
  expect(resumed.complete).toBe(true);
  expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe(
    "created\n",
  );
  await writeFile(join(workspace, "skip-skill-read.flag"), "\n");
  const explicit = {
    ...request,
    prompt: "Use $probe:probe and return ready.",
    explicitSkillInvocation: {
      pluginName: "probe",
      skillName: "probe",
      token: "$probe:probe",
    },
  };
  const dispatched = await host.run(explicit);
  expectUnknown(dispatched.observations).toContainEqual({
    id: "sevro.codex.explicit-invocation",
    completeness: "complete",
    data: {
      method: "explicit_invocation",
      primarySkill: "probe",
    },
  });
  expect(
    host.run({ ...explicit, prompt: "Use $probe:probe twice: $probe:probe." }),
  ).rejects.toThrow(/invalid Codex explicit skill invocation/);
  await writeFile(join(packageRoot, "unlisted.txt"), "extra\n");
  expect(host.run(request)).rejects.toThrow(/undeclared files/);
  await rm(join(packageRoot, "unlisted.txt"));
  await writeFile(
    join(packageRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "sevro-probe",
      owner: { name: "Sevro" },
      plugins: [
        {
          name: "probe",
          source: "https://example.com/plugin",
          description: "Probe",
        },
      ],
    }),
  );
  expect(host.run(request)).rejects.toThrow(/declared local source/);
}, 60_000);

test("Codex host dispatches a verified repository skill without a plugin", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-codex-repository-"),
  );

  const skillRoot = join(workspace, ".agents", "skills", "probe");
  const skillFile = join(skillRoot, "SKILL.md");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    skillFile,
    "---\nname: probe\ndescription: Test probe\n---\nRead this skill.\n",
  );
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const request = {
    prompt: "Use $probe and return ready.",
    workspace,
    condition: "passive" as const,
    explicitSkillInvocation: {
      scope: "repository" as const,
      skillName: "probe",
      token: "$probe",
    },
  };
  const result = await host.run(request);
  expect(result.complete).toBe(true);
  expect(result.finalMessage).toBe("ready");
  expect(await readFile(join(workspace, "prompt.txt"), "utf8")).toBe(
    request.prompt,
  );
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.codex.explicit-invocation",
    completeness: "complete",
    data: {
      method: "explicit_invocation",
      primarySkill: "probe",
    },
  });
  expect(
    host.run({ ...request, followUpPrompt: "Use $probe again." }),
  ).rejects.toThrow(/invalid Codex explicit skill invocation/);
  expect(
    host.run({
      ...request,
      explicitSkillInvocation: {
        ...request.explicitSkillInvocation,
        token: "$other",
      },
      prompt: "Use $other.",
    }),
  ).rejects.toThrow(/invalid Codex explicit skill invocation/);
  await rm(skillFile);
  expect(host.run(request)).rejects.toThrow(/unavailable or unsafe/);
  const linkedFile = join(workspace, "linked-skill.md");
  await writeFile(linkedFile, "---\nname: probe\n---\n");
  await symlink(linkedFile, skillFile);
  expect(host.run(request)).rejects.toThrow(/unavailable or unsafe/);
  await rm(skillRoot, { recursive: true });
  const linkedRoot = join(workspace, "linked-skill");
  await mkdir(linkedRoot);
  await writeFile(join(linkedRoot, "SKILL.md"), "---\nname: probe\n---\n");
  await symlink(linkedRoot, skillRoot);
  expect(host.run(request)).rejects.toThrow(/unavailable or unsafe/);
});

test.each([false, true])(
  "Codex skips dependencies for plugins without authorized command handlers: %s",
  async (allowed) => {
    const selected = await ordinaryMarketplace(roots);
    const source = await realpath(selected.paths.projectRoot);
    const host = createCodexHost({
      ...ordinaryCodexOptions,
      binary: selected.paths.fakeBinary,
      authFile: selected.paths.authFile,
      projectRoot: selected.paths.projectRoot,
      resultsRoot: selected.paths.resultsRoot,
      sandboxBinary: defined(Bun.which("true")),
    });
    const result = await host.run({
      ...selected.request,
      codexMarketplace: selected.declaration,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [
          { source, target: "cache", sha256: "a".repeat(64), roles: ["hooks"] },
        ],
        hooks: { plugins: allowed ? ["probe"] : [] },
      },
    });
    expect(result.complete).toBe(true);
    expect(
      result.observations?.find((item) => item.id === "sevro.host.hooks")?.data
        .plugins,
    ).toMatchObject([{ name: "probe", allowed }]);
  },
);
