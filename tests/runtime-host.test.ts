import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexHost } from "../src/hosts/codex";
import { createClaudeHost } from "../src/hosts/claude";
import { runtimeSeedDigest } from "../src/runtime-seeds";
import {
  loadRuntimeConfiguration,
  runEvaluation,
  type HostAdapter,
} from "../src/engine";
import { parseRunEvidence } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Claude fixture binaries keep precedence with a declared PATH", async () => {
  const { root, workspace, bin } = await codexFixture();
  const fixtureBinDir = join(workspace, ".git", "fixture-bin");
  await mkdir(fixtureBinDir, { recursive: true });
  await writeFile(join(fixtureBinDir, "probe"), "#!/bin/sh\nprintf fixture\n", {
    mode: 0o755,
  });
  const binary = join(root, "claude-fixture");
  await writeFile(
    binary,
    `#!/bin/sh
answer=$(probe)
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n' "$answer"
`,
    { mode: 0o755 },
  );
  const credentialFile = join(root, "claude-credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Return probe output.",
    workspace,
    fixtureBinDir,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "host tool",
      },
      readOnlyRoots: [bin],
    },
  });
  expect(result.finalMessage).toBe("fixture");
});

test("Claude refuses direct read access to an original seed source", async () => {
  const { root, workspace } = await codexFixture();
  const source = join(root, "seed");
  await mkdir(source);
  const binary = join(root, "claude-fixture");
  await writeFile(
    binary,
    '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
    { mode: 0o755 },
  );
  const credentialFile = join(root, "claude-credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [source],
        seeds: [
          { source, target: "cache", sha256: await runtimeSeedDigest(source) },
        ],
      },
    }),
  ).rejects.toThrow("protected data");
});

async function codexFixture(
  command = "probe",
  additionalProtectedRoots: string[] = [],
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-runtime-host-")),
  );
  roots.push(root);
  const project = join(root, "project"),
    results = join(root, "results"),
    workspace = join(root, "workspace"),
    bin = join(root, "tools");
  await Promise.all(
    [project, results, workspace, bin].map((path) => mkdir(path)),
  );
  await writeFile(
    join(bin, "probe"),
    '#!/bin/sh\nprintf "%s" "$SEVRO_RUNTIME_SAMPLE"\n',
  );
  await chmod(join(bin, "probe"), 0o755);
  const codex = defined(Bun.which("codex"));
  const binary = join(root, "candidate");
  await writeFile(
    binary,
    `#!/bin/sh
/bin/cat >/dev/null
profile=$(/usr/bin/sed -n 's/^default_permissions = "\\(.*\\)"/\\1/p' "$CODEX_HOME/config.toml")
answer=$('${codex}' sandbox -P "$profile" -C "$PWD" -- /bin/sh -c '${command}' 2>"$PWD/sandbox-error") || answer=unavailable
printf '%s\\n' '{"type":"thread.started","thread_id":"runtime-test"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$answer"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
  );
  await chmod(binary, 0o755);
  const auth = join(root, "auth.json");
  await writeFile(auth, "synthetic-auth");
  const host = createCodexHost({
    binary,
    sandboxBinary: codex,
    authFile: auth,
    projectRoot: project,
    resultsRoot: results,
    additionalProtectedRoots: [auth, ...additionalProtectedRoots],
    model: "synthetic",
    effort: "low",
  });
  return { host, workspace, root, bin };
}

test("Codex candidate commands use the declared runtime environment", async () => {
  const { host, workspace, bin } = await codexFixture();
  const result = await host.run({
    prompt: "Return probe output.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "from caller",
      },
      readOnlyRoots: [bin],
    },
  });
  expect(result.complete).toBe(true);
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("from caller");
});

test("Codex resolved support-tree aliases grant reads and refuse writes", async () => {
  const support = await realpath(
    await mkdtemp(join(homedir(), ".sevro-runtime-alias-")),
  );
  roots.push(support);
  const source = join(support, "protected-source"),
    privateSibling = join(support, "private-sibling"),
    deniedFile = join(support, "protected-login.json");
  await Promise.all([source, privateSibling].map((path) => mkdir(path)));
  await writeFile(join(source, "value"), "source marker");
  await writeFile(join(privateSibling, "value"), "private sibling marker");
  await writeFile(deniedFile, "login marker");
  const { host, workspace, root } = await codexFixture(
    '/bin/cat "$SUPPORT_ALIAS/value"; if printf changed > "$SUPPORT_ALIAS/value" 2>/dev/null; then printf writable; fi; for path in "$SUPPORT_SOURCE/value" "$SUPPORT_PRIVATE/value" "$SUPPORT_DENIED_FILE"; do if /bin/cat "$path" >/dev/null 2>&1; then printf private-readable; fi; done',
    [source, deniedFile],
  );
  const cellar = join(support, "Cellar"),
    opt = join(support, "opt");
  const target = join(cellar, "package"),
    alias = join(opt, "package");
  await mkdir(target, { recursive: true });
  await mkdir(opt);
  await writeFile(join(target, "value"), "alias support");
  await symlink(target, alias);
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: {
        set: {
          SUPPORT_ALIAS: alias,
          SUPPORT_SOURCE: source,
          SUPPORT_PRIVATE: privateSibling,
          SUPPORT_DENIED_FILE: deniedFile,
        },
      },
      filesystem: { optionalReadOnlyRoots: [opt, cellar] },
    }),
  );
  const policy = await loadRuntimeConfiguration(
    join(root, "project"),
    join(root, "runtime.json"),
  );
  const result = await host.run({
    prompt: "Read support",
    workspace,
    condition: "passive",
    runtimePolicy: policy,
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("alias support");
  expect(await readFile(join(target, "value"), "utf8")).toBe("alias support");
});

test.skipIf(process.platform !== "linux")(
  "Codex retains protected home denial inside platform read baselines",
  async () => {
    const { root, workspace } = await codexFixture(
      "if /bin/cat /usr/bin/env >/dev/null 2>&1; then printf exposed; else printf blocked; fi",
    );
    const peer = join(root, "baseline-peer.ts");
    const options = {
      binary: join(root, "candidate"),
      sandboxBinary: defined(Bun.which("codex")),
      authFile: join(root, "auth.json"),
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [join(root, "auth.json")],
      model: "synthetic",
      effort: "low",
    };
    const request = {
      prompt: "Inspect runtime",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: ["/usr/local/bin"],
      },
    };
    await writeFile(
      peer,
      `import {createCodexHost} from ${JSON.stringify(join(import.meta.dir, "../src/hosts/codex.ts"))};
try { const result = await createCodexHost(${JSON.stringify(options)}).run(${JSON.stringify(request)}); console.log(result.finalMessage); }
catch (cause) { if (!(cause instanceof Error) || !/Codex (?:isolation|executable) preflight failed/.test(cause.message)) throw cause; console.log("blocked-before-execution"); }
`,
    );
    const child = Bun.spawn([process.execPath, peer], {
      env: { ...process.env, HOME: "/usr" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(["blocked", "blocked-before-execution"]).toContain(stdout.trim());
  },
);

test.skipIf(process.platform !== "darwin")(
  "Codex selected Apple Git can query configuration",
  async () => {
    const { host, root, workspace } = await codexFixture(
      'git config --system --get sevro.nonexistent.runtimeprobe; code=$?; test "$code" -eq 1 && printf accessible',
    );
    await writeFile(
      join(root, "runtime.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: "/usr/bin:/bin" } },
      }),
    );
    const runtimePolicy = await loadRuntimeConfiguration(
      join(root, "project"),
      join(root, "runtime.json"),
    );
    const result = await host.run({
      prompt: "Query Git",
      workspace,
      condition: "passive",
      runtimePolicy,
    });
    expect(
      result.finalMessage,
      await readFile(join(workspace, "sandbox-error"), "utf8"),
    ).toBe("accessible");
  },
  15000,
);

test("Codex candidate commands use private runtime seeds", async () => {
  const { host, workspace, root } = await codexFixture(
    '/bin/cat "$UV_CACHE_DIR/input"; /bin/echo changed > "$UV_CACHE_DIR/input"',
  );
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(join(source, "input"), "seeded");
  const result = await host.run({
    prompt: "Use the private cache.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { UV_CACHE_DIR: "{{sevro.runtime}}/cache" },
      readOnlyRoots: [],
      seeds: [
        { source, target: "cache", sha256: await runtimeSeedDigest(source) },
      ],
    },
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("seeded");
  expect(await readFile(join(source, "input"), "utf8")).toBe("seeded");
});

test("Codex refuses a seed changed after its configuration snapshot", async () => {
  const { host, workspace, root } = await codexFixture();
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(join(source, "input"), "original");
  const sha256 = await runtimeSeedDigest(source);
  await writeFile(join(source, "input"), "changed");
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [{ source, target: "cache", sha256 }],
      },
    }),
  ).rejects.toThrow("changed after");
});

test("Codex refuses a file planted in an owned runtime seed slot", async () => {
  const { host, workspace, root } = await codexFixture();
  const source = join(root, "seed");
  await mkdir(source);
  const directory = join(workspace, ".git/sevro-runtime/candidate");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "cache"), "not a directory");
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [
          { source, target: "cache", sha256: await runtimeSeedDigest(source) },
        ],
      },
    }),
  ).rejects.toThrow("not a directory");
});

test("Codex rejects runner-owned environment values in direct runtime requests", async () => {
  const { host, workspace } = await codexFixture();
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { NODE_OPTIONS: "--no-warnings" },
        readOnlyRoots: [],
      },
    }),
  ).rejects.toThrow("protected");
});

// Keep the public evaluation invocation and both role outcomes together; bounded by the 200-line test rule.
// eslint-disable-next-line max-lines-per-function
test("evaluation applies the selected runtime policy to semantic and advisory hosts", async () => {
  const { root } = await codexFixture();
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      if (
        request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE !== "selected"
      )
        throw new Error("runtime unavailable");
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const advisoryHost: HostAdapter = {
    ...host,
    id: "runtime.advisory",
    run(request) {
      if (
        request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE !== "selected"
      )
        throw new Error("runtime unavailable");
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          verdict: "pass",
          overallScore: 5,
          dimensions: {
            correctness: 5,
            maintainability: 5,
            testQuality: 5,
            scopeDiscipline: 5,
          },
          strengths: [],
          weaknesses: [],
          summary: "Ready",
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "results-evaluation"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    advisoryHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { SEVRO_RUNTIME_SAMPLE: "selected" },
      readOnlyRoots: [],
    },
    case: {
      id: "runtime-roles",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [{ message: "baseline", files: { "README.md": "baseline" } }],
      },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
      requiredEvidence: [],
    },
  });
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(result.task.verdict, JSON.stringify(evidence.trials)).toBe("passed");
  expect(defined(evidence.trials[0]).advisoryReview?.status).toBe("completed");
});

test.each(["..", "home", "tmp"])(
  "Codex refuses reserved or escaping runtime seed target: %s",
  async (target) => {
    const { host, root, workspace } = await codexFixture();
    const source = join(root, "seed");
    await mkdir(source);
    expect(
      host.run({
        prompt: "Return ready.",
        workspace,
        condition: "passive",
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          seeds: [{ source, target, sha256: await runtimeSeedDigest(source) }],
        },
      }),
    ).rejects.toThrow("target");
  },
);

test("evaluation refuses credential-bearing runtime policy before creating results", async () => {
  const { root } = await codexFixture();
  const resultsRoot = join(root, "private-results");
  const host: HostAdapter = {
    id: "runtime.stub",
    model: "synthetic",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  expect(
    runEvaluation({
      projectRoot: root,
      resultsRoot,
      runnerBuildDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
      host,
      case: {
        id: "credential-runtime",
        prompt: "Return ready",
        fixture: { files: {} },
        checks: [],
        requiredEvidence: [],
      },
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { OPENAI_API_KEY: "synthetic-private-value" },
        readOnlyRoots: [],
      },
    }),
  ).rejects.toThrow("protected");
  expect(await Bun.file(resultsRoot).exists()).toBe(false);
});

test("Codex refuses native-goal runtime policy on the exec route", async () => {
  const { host, workspace } = await codexFixture();
  expect(
    host.run({
      prompt: "Complete the native goal.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        hooks: { nativeGoal: true },
      },
    }),
  ).rejects.toThrow("app-server");
});

test("evaluation snapshots runtime values before a caller changes them", async () => {
  const { root } = await codexFixture();
  const policy = {
    format: "sevro.runtime.v1" as const,
    environment: { SEVRO_RUNTIME_SAMPLE: "selected" },
    readOnlyRoots: [],
  };
  const host: HostAdapter = {
    id: "runtime.stub",
    model: "synthetic",
    effort: "none",
    run() {
      policy.environment.SEVRO_RUNTIME_SAMPLE = "changed";
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [
            {
              id: "meaning",
              verdict:
                request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE ===
                "selected"
                  ? "pass"
                  : "fail",
              reason: "Runtime value observed",
            },
          ],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "snapshot-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    case: {
      id: "snapshot-runtime",
      prompt: "Return ready",
      fixture: { files: {} },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The runtime is selected." },
        },
      ],
      requiredEvidence: [],
    },
    runtimePolicy: policy,
  });
  expect(result.task.verdict).toBe("passed");
});

test("Codex can reuse a declared native installation under the real home", async () => {
  const { root, workspace, bin } = await codexFixture();
  const installation = await realpath(
    await mkdtemp(join(homedir(), ".sevro-native-runtime-")),
  );
  roots.push(installation);
  const binary = join(installation, "candidate");
  await writeFile(binary, await readFile(join(root, "candidate")), {
    mode: 0o700,
  });
  const host = createCodexHost({
    binary,
    sandboxBinary: defined(Bun.which("codex")),
    authFile: join(root, "auth.json"),
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [join(root, "auth.json")],
    model: "synthetic",
    effort: "low",
  });
  const result = await host.run({
    prompt: "Return probe output",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "from caller",
      },
      readOnlyRoots: [installation, bin],
    },
  });
  expect(result.finalMessage).toBe("from caller");
});

test("Codex declared PATH preserves fixture tool access", async () => {
  const { host, workspace } = await codexFixture("fixture-probe");
  const fixtureBinDir = join(workspace, ".git/fixture-bin");
  await mkdir(fixtureBinDir, { recursive: true });
  await writeFile(
    join(fixtureBinDir, "fixture-probe"),
    '#!/bin/sh\nprintf "fixture wins"\n',
    { mode: 0o700 },
  );
  const result = await host.run({
    prompt: "Return fixture output",
    workspace,
    fixtureBinDir,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { PATH: "/usr/bin:/bin" },
      readOnlyRoots: [],
    },
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("fixture wins");
});

test("evaluation retains complete native runtime policy evidence", async () => {
  const { host, root, bin } = await codexFixture();
  const { result } = await runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    case: {
      id: "runtime-evidence",
      prompt: "Return probe output",
      fixture: { files: {} },
      checks: [],
      requiredEvidence: ["sevro.host.runtime"],
    },
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "from caller",
      },
      readOnlyRoots: [bin],
    },
  });
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  const observation = defined(evidence.trials[0]).observations.find(
    (row) => row.id === "sevro.host.runtime",
  );
  expect(observation?.completeness).toBe("complete");
  expect(observation?.data.environmentNames).toContain("SEVRO_RUNTIME_SAMPLE");
  expect(observation?.data.role).toBe("candidate");
});
