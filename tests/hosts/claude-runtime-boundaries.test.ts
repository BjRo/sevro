import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  createClaudeHost,
  type ClaudeHostOptions,
} from "../../src/hosts/claude";
import {
  withAuthenticationEnvironment,
  withSyntheticKeychain,
} from "../fixtures/host-auth";
import { defined, record } from "../fixtures/assertions";
import { createWorkspace } from "../fixtures/native-host-fixtures";

const testDirectory = join(import.meta.dir, "..");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const workspace = createWorkspace(roots);

const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));

async function claudeHostFixture() {
  const root = await workspace(),
    candidate = join(root, "candidate"),
    source = join(root, "source"),
    results = join(root, "results"),
    binary = join(root, "synthetic-claude"),
    credential = join(root, "credential.json");
  await rm(join(root, ".git"), { recursive: true });
  await Promise.all([
    mkdir(join(candidate, ".git"), { recursive: true }),
    mkdir(source),
    mkdir(results),
  ]);
  await cp(join(testDirectory, "fixtures/host-claude.ts"), binary);
  await chmod(binary, 0o700);
  await writeFile(credential, '{"login":"PRIVATE_TEST_LOGIN"}');
  const options: ClaudeHostOptions = {
    binary,
    model: "synthetic",
    effort: "low",
    projectRoot: source,
    resultsRoot: results,
    additionalProtectedRoots: [],
    credentialFile: credential,
  };
  return {
    root,
    candidate,
    source,
    results,
    binary,
    credential,
    options,
    request: {
      prompt: "ready",
      workspace: candidate,
      condition: "passive" as const,
    },
  };
}

type ClaudeFixture = Awaited<ReturnType<typeof claudeHostFixture>>;

type ClaudeRequest = Parameters<ReturnType<typeof createClaudeHost>["run"]>[0];

async function claudeCapture(fixture: Pick<ClaudeFixture, "candidate">) {
  return record(
    JSON.parse(
      await readFile(join(fixture.candidate, "authentication.json"), "utf8"),
    ),
  );
}

function captureConfig(capture: Record<string, unknown>): string {
  if (typeof capture.config !== "string")
    throw new Error("Expected captured configuration path");
  return capture.config;
}

function credentialEnvironment(
  root: string,
): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CONFIG_DIR: join(root, "ambient"),
    USER: "quality-account",
    LOGNAME: undefined,
  };
}

function requirePrivateResult(
  result: Awaited<ReturnType<ReturnType<typeof createClaudeHost>["run"]>>,
) {
  expect(result.complete).toBe(true);
  expect(result.finalMessage).toBe("ready");
  expect(JSON.stringify(result.observations)).not.toMatch(
    /PRIVATE_TEST_LOGIN|PRIVATE_API_KEY|PRIVATE_OAUTH_TOKEN|PRIVATE_GOAL_OBJECTIVE/,
  );
}

test("Claude explicit credential takes precedence over inherited authentication", async () => {
  if (!isolatedNativeHost) return;
  const fixture = await claudeHostFixture();
  await withAuthenticationEnvironment(
    {
      ...credentialEnvironment(fixture.root),
      ANTHROPIC_API_KEY: "PRIVATE_API_KEY",
      CLAUDE_CODE_OAUTH_TOKEN: "PRIVATE_OAUTH_TOKEN",
    },
    async () => {
      const result = await createClaudeHost(fixture.options).run(
        fixture.request,
      );
      requirePrivateResult(result);
      const capture = await claudeCapture(fixture);
      expect(capture).toMatchObject({
        saved: true,
        expectedLogin: true,
        permission: 0o600,
        userRules: false,
        userSettings: false,
        api: false,
        oauth: false,
        scrub: "1",
      });
      expect(
        readFile(join(captureConfig(capture), ".credentials.json")),
      ).rejects.toThrow();
    },
  );
});

test.each(["api", "oauth", "both"])(
  "Claude inherited %s credentials stay in the host environment",
  async (mode) => {
    if (!isolatedNativeHost) return;
    const fixture = await claudeHostFixture();
    delete fixture.options.credentialFile;
    const environment = {
      ...credentialEnvironment(fixture.root),
      ANTHROPIC_API_KEY: mode === "oauth" ? undefined : "PRIVATE_API_KEY",
      CLAUDE_CODE_OAUTH_TOKEN:
        mode === "api" ? undefined : "PRIVATE_OAUTH_TOKEN",
    };
    await withAuthenticationEnvironment(environment, async () => {
      requirePrivateResult(
        await createClaudeHost(fixture.options).run(fixture.request),
      );
      expect(await claudeCapture(fixture)).toMatchObject({
        saved: false,
        api: mode !== "oauth",
        oauth: mode !== "api",
        scrub: "1",
      });
    });
  },
);

test("Claude saved configuration contributes only credentials to private state", async () => {
  if (!isolatedNativeHost) return;
  const fixture = await claudeHostFixture();
  delete fixture.options.credentialFile;
  const saved = join(fixture.root, "saved");
  await mkdir(saved);
  await writeFile(
    join(saved, ".credentials.json"),
    '{"login":"PRIVATE_TEST_LOGIN"}',
  );
  await writeFile(join(saved, "CLAUDE.md"), "PRIVATE_USER_RULE");
  await writeFile(
    join(saved, "settings.json"),
    '{"userSetting":"PRIVATE_SETTING"}',
  );
  await withAuthenticationEnvironment(
    { ...credentialEnvironment(fixture.root), CLAUDE_CONFIG_DIR: saved },
    async () => {
      requirePrivateResult(
        await createClaudeHost(fixture.options).run(fixture.request),
      );
      const capture = await claudeCapture(fixture);
      expect(capture).toMatchObject({
        saved: true,
        expectedLogin: true,
        permission: 0o600,
        userRules: false,
        userSettings: false,
      });
      expect(
        readFile(join(captureConfig(capture), "CLAUDE.md")),
      ).rejects.toThrow();
    },
  );
});

test.each(["empty", "whitespace", "oversized", "missing"])(
  "Claude selected credential %s refuses execution without fallback",
  async (mode) => {
    if (!isolatedNativeHost) return;
    const fixture = await claudeHostFixture();
    const bytes: Record<string, string> = {
      empty: "",
      whitespace: " \n\t",
      oversized: "x".repeat(1024 * 1024 + 1),
    };
    if (mode === "missing") await rm(fixture.credential);
    else await writeFile(fixture.credential, defined(bytes[mode]));
    expect(
      createClaudeHost(fixture.options).run(fixture.request),
    ).rejects.toThrow(
      /credential is (?:empty or oversized|unreadable or unavailable)/,
    );
    expect(
      readFile(join(fixture.candidate, "authentication.json")),
    ).rejects.toThrow();
  },
);

test("Claude unreadable saved configuration refuses authentication rather than querying another login", async () => {
  if (!isolatedNativeHost) return;
  const fixture = await claudeHostFixture();
  delete fixture.options.credentialFile;
  await withAuthenticationEnvironment(
    credentialEnvironment(fixture.credential),
    () => {
      expect(
        createClaudeHost(fixture.options).run(fixture.request),
      ).rejects.toThrow(/saved credential is unreadable or unavailable/);
    },
  );
});

test("Claude refuses an oversized environment credential before model execution", async () => {
  if (!isolatedNativeHost) return;
  const fixture = await claudeHostFixture();
  delete fixture.options.credentialFile;
  await withAuthenticationEnvironment(
    {
      ...credentialEnvironment(fixture.root),
      ANTHROPIC_API_KEY: "x".repeat(1024 * 1024 + 1),
    },
    () => {
      expect(
        createClaudeHost(fixture.options).run(fixture.request),
      ).rejects.toThrow(/environment credential exceeds the size limit/);
    },
  );
});

test.each([true, false])(
  "Claude missing saved credentials use the synthetic keychain account=%s",
  async (account) => {
    if (process.platform !== "darwin") return;
    const fixture = await claudeHostFixture();
    delete fixture.options.credentialFile;
    await withAuthenticationEnvironment(
      {
        ...credentialEnvironment(fixture.root),
        USER: account ? "quality-account" : undefined,
      },
      async () => {
        await withSyntheticKeychain("success", account, async () => {
          requirePrivateResult(
            await createClaudeHost(fixture.options).run(fixture.request),
          );
          expect(await claudeCapture(fixture)).toMatchObject({
            saved: true,
            permission: 0o600,
            expectedLogin: true,
          });
        });
      },
    );
  },
);

test.each(["failure", "empty", "whitespace", "oversized", "slow"])(
  "Claude keychain %s cannot become authenticated success",
  async (mode) => {
    if (process.platform !== "darwin") return;
    const fixture = await claudeHostFixture();
    delete fixture.options.credentialFile;
    const marker = join(fixture.root, "security.pid");
    await withAuthenticationEnvironment(
      {
        ...credentialEnvironment(fixture.root),
        SEVRO_QUALITY_SECURITY_PID: marker,
      },
      async () => {
        await withSyntheticKeychain(mode, true, () => {
          expect(
            createClaudeHost(fixture.options).run(fixture.request),
          ).rejects.toThrow(
            /credential is (?:empty or oversized|unreadable or unavailable)/,
          );
        });
        const pid = Number(await readFile(marker, "utf8"));
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(
          readFile(join(fixture.candidate, "authentication.json")),
        ).rejects.toThrow();
      },
    );
  },
);

test.each([
  ["ready", "complete"],
  ["goal-active", "active"],
  ["goal-blocked", "blocked"],
  ["goal-cleared", "cleared"],
] as const)(
  "Claude retained native goal reports %s as %s without its objective",
  async (mode, status) => {
    if (!isolatedNativeHost) return;
    const fixture = await claudeHostFixture();
    fixture.request.prompt = mode;
    const result = await createClaudeHost(fixture.options).run(fixture.request);
    requirePrivateResult(result);
    expect(
      result.observations?.find((item) => item.id === "sevro.host.native-goal"),
    ).toMatchObject({
      completeness: "complete",
      data: { goalStatus: status, goals: [{ status, characters: 23 }] },
    });
  },
);

test.each([
  "goal-malformed",
  "goal-too-long",
  "goal-no-objective",
  "goal-foreign",
  "goal-ambiguous",
])(
  "Claude malformed persisted native goal remains unavailable: %s",
  async (mode) => {
    if (!isolatedNativeHost) return;
    const fixture = await claudeHostFixture();
    fixture.request.prompt = mode;
    const result = await createClaudeHost(fixture.options).run(fixture.request);
    expect(result.complete).toBe(true);
    expect(
      result.observations?.find((item) => item.id === "sevro.host.native-goal"),
    ).toMatchObject({ completeness: "unavailable" });
    expect(JSON.stringify(result.observations)).not.toContain(
      "PRIVATE_GOAL_OBJECTIVE",
    );
  },
);

const invalidClaudeOptions: Array<{
  label: string;
  change: Partial<ClaudeHostOptions>;
}> = [
  { label: "relative binary", change: { binary: "relative" } },
  { label: "relative credential", change: { credentialFile: "relative" } },
  { label: "relative toolchain", change: { toolchainBinDir: "relative" } },
  { label: "relative cache", change: { uvCacheDir: "relative" } },
  {
    label: "relative private root",
    change: { additionalProtectedRoots: ["relative"] },
  },
  { label: "missing model", change: { model: "" } },
  { label: "missing effort", change: { effort: "" } },
  { label: "zero timeout", change: { timeoutMs: 0 } },
  { label: "fractional timeout", change: { timeoutMs: 1.5 } },
  { label: "excessive timeout", change: { timeoutMs: 30 * 60_000 + 1 } },
];

test.each(invalidClaudeOptions)(
  "Claude route refuses invalid configuration: %s",
  async ({ change }) => {
    if (!isolatedNativeHost) return;
    const fixture = await claudeHostFixture();
    expect(() => createClaudeHost({ ...fixture.options, ...change })).toThrow(
      /invalid Claude host configuration/,
    );
  },
);

test.each([
  "follow-up",
  "condition",
  "instrumentation",
  "fixture-bin",
  "repository-source",
])("Claude route refuses undeclared execution change: %s", async (mode) => {
  if (!isolatedNativeHost) return;
  const fixture = await claudeHostFixture();
  const request: ClaudeRequest = { ...fixture.request };
  const changes: Record<string, () => void> = {
    "follow-up": () => {
      request.followUpPrompt = " \n";
    },
    condition: () => {
      request.condition = "enforced";
    },
    instrumentation: () => {
      request.instrumentation = [
        { id: "example.enforcement", configuration: {} },
      ];
    },
    "fixture-bin": () => {
      request.fixtureBinDir = fixture.root;
    },
    "repository-source": () => {
      request.explicitSkillInvocation = {
        scope: "repository",
        skillName: "probe",
        token: "/probe",
      };
    },
  };
  defined(changes[mode])();
  expect(createClaudeHost(fixture.options).run(request)).rejects.toThrow(
    /follow-up prompt|enforcement instrumentation|binary path is outside|requires project setting sources/,
  );
  expect(
    readFile(join(fixture.candidate, "authentication.json")),
  ).rejects.toThrow();
});

async function claudePluginFixture() {
  const fixture = await claudeHostFixture(),
    relativeRoot = "package/probe",
    plugin = join(fixture.candidate, relativeRoot);
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, "skills/probe"), { recursive: true });
  await writeFile(
    join(plugin, ".claude-plugin/plugin.json"),
    '{"name":"probe"}',
  );
  await writeFile(
    join(plugin, "skills/probe/SKILL.md"),
    "Use the declared probe skill.\n",
  );
  const request: ClaudeRequest = {
    ...fixture.request,
    prompt: "Use /probe:probe",
    explicitSkillInvocation: {
      pluginName: "probe",
      skillName: "probe",
      token: "/probe:probe",
    },
    claudePluginDirs: {
      artifactRoots: [relativeRoot],
      artifactPaths: [
        `${relativeRoot}/.claude-plugin/plugin.json`,
        `${relativeRoot}/skills/probe/SKILL.md`,
      ],
    },
  };
  return { ...fixture, plugin, relativeRoot, request };
}

type ClaudePluginFixture = Awaited<ReturnType<typeof claudePluginFixture>>;

async function invalidatePlugin(fixture: ClaudePluginFixture, mode: string) {
  const declaration = defined(fixture.request.claudePluginDirs);
  const actions: Record<string, () => Promise<void>> = {
    "duplicate roots": () => {
      declaration.artifactRoots.push(fixture.relativeRoot);
      return Promise.resolve();
    },
    "duplicate artifacts": () => {
      declaration.artifactPaths.push(defined(declaration.artifactPaths[0]));
      return Promise.resolve();
    },
    "undeclared manifest": () => {
      declaration.artifactPaths.shift();
      return Promise.resolve();
    },
    "malformed manifest": () =>
      writeFile(join(fixture.plugin, ".claude-plugin/plugin.json"), "{broken"),
    "wrong manifest identity": () =>
      writeFile(
        join(fixture.plugin, ".claude-plugin/plugin.json"),
        '{"name":"foreign"}',
      ),
    "nonfile skill": async () => {
      const path = join(fixture.plugin, "skills/probe/SKILL.md");
      await rm(path);
      await mkdir(path);
    },
    "outside artifact": async () => {
      await writeFile(join(fixture.candidate, "outside.txt"), "outside");
      declaration.artifactPaths.push("outside.txt");
    },
    "redirected artifact": async () => {
      const path = join(fixture.plugin, "skills/probe/SKILL.md");
      await rm(path);
      await symlink(fixture.credential, path);
    },
    "overlapping aliases": async () => {
      await symlink(fixture.plugin, join(fixture.candidate, "package/alias"));
      declaration.artifactRoots.push("package/alias");
      declaration.artifactPaths.push(
        "package/alias/.claude-plugin/plugin.json",
      );
    },
    "nested roots": async () => {
      await mkdir(join(fixture.plugin, "nested/.claude-plugin"), {
        recursive: true,
      });
      await writeFile(
        join(fixture.plugin, "nested/.claude-plugin/plugin.json"),
        "{}",
      );
      declaration.artifactRoots.push(`${fixture.relativeRoot}/nested`);
      declaration.artifactPaths.push(
        `${fixture.relativeRoot}/nested/.claude-plugin/plugin.json`,
      );
    },
  };
  await defined(actions[mode])();
}

test.each([
  "duplicate roots",
  "duplicate artifacts",
  "undeclared manifest",
  "malformed manifest",
  "wrong manifest identity",
  "nonfile skill",
  "outside artifact",
  "redirected artifact",
  "overlapping aliases",
  "nested roots",
])("Claude refuses an unsafe declared plugin: %s", async (mode) => {
  if (!isolatedNativeHost) return;
  const fixture = await claudePluginFixture();
  await invalidatePlugin(fixture, mode);
  expect(
    createClaudeHost(fixture.options).run(fixture.request),
  ).rejects.toThrow(
    /duplicates|undeclared|manifest|absent|outside|escapes|overlap/,
  );
  expect(
    readFile(join(fixture.candidate, "authentication.json")),
  ).rejects.toThrow();
});

test("Claude verifies a declared plugin invocation before the real host process", async () => {
  if (!isolatedNativeHost) return;
  const fixture = await claudePluginFixture();
  requirePrivateResult(
    await createClaudeHost(fixture.options).run(fixture.request),
  );
  expect(await claudeCapture(fixture)).toMatchObject({
    saved: true,
    expectedLogin: true,
  });
});

test.each([
  "missing",
  "repeated",
  "invalid-token",
  "invalid-plugin",
  "invalid-skill",
])("Claude explicit dispatch refuses %s invocation", async (mode) => {
  if (!isolatedNativeHost) return;
  const fixture = await claudePluginFixture();
  const changes: Record<string, () => void> = {
    missing: () => {
      fixture.request.prompt = "No dispatch token";
    },
    repeated: () => {
      fixture.request.prompt = "/probe:probe /probe:probe";
    },
    "invalid-token": () => {
      fixture.request.explicitSkillInvocation = {
        pluginName: "probe",
        skillName: "probe",
        token: "/wrong",
      };
      fixture.request.prompt = "/wrong";
    },
    "invalid-plugin": () => {
      fixture.request.explicitSkillInvocation = {
        pluginName: "UPPER",
        skillName: "probe",
        token: "/UPPER:probe",
      };
      fixture.request.prompt = "/UPPER:probe";
    },
    "invalid-skill": () => {
      fixture.request.explicitSkillInvocation = {
        pluginName: "probe",
        skillName: "bad/name",
        token: "/probe:bad/name",
      };
      fixture.request.prompt = "/probe:bad/name";
    },
  };
  defined(changes[mode])();
  expect(
    createClaudeHost(fixture.options).run(fixture.request),
  ).rejects.toThrow(/invalid Claude explicit skill invocation/);
});

test.each(["executable", "toolchain", "cache"])(
  "Claude refuses protected %s execution assets",
  async (mode) => {
    if (!isolatedNativeHost) return;
    const fixture = await claudeHostFixture();
    const options: ClaudeHostOptions = { ...fixture.options };
    if (mode === "executable")
      options.additionalProtectedRoots = [fixture.binary];
    if (mode === "toolchain") options.toolchainBinDir = fixture.source;
    if (mode === "cache") options.uvCacheDir = fixture.source;
    expect(createClaudeHost(options).run(fixture.request)).rejects.toThrow(
      /executable resides inside|toolchain directory|UV cache/,
    );
    expect(
      readFile(join(fixture.candidate, "authentication.json")),
    ).rejects.toThrow();
  },
);
