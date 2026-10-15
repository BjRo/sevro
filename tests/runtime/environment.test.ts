import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createClaudeHost } from "../../src/hosts/claude";
import { loadRuntimeConfiguration, runEvaluation } from "../../src/engine";
import { parseRunEvidence } from "../fixtures/assertions";
import { defined } from "../fixtures/assertions";
import { createCodexFixture } from "../fixtures/runtime-host-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const codexFixture = createCodexFixture(roots);

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

test.skipIf(process.platform !== "darwin").each([false, true])(
  "Codex zsh here-documents use private temporary storage with runtime policy %s",
  async (withRuntimePolicy) => {
    const { host, workspace, root } = await codexFixture(
      "/bin/zsh ./temp-probe.zsh > temp-probe.out && printf ready",
    );
    const sharedTemp = join("/tmp", basename(root));
    roots.push(sharedTemp);
    await writeFile(sharedTemp, "host-private");
    await writeFile(
      join(root, "project", "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: "/usr/bin:/bin" } },
      }),
    );
    if (withRuntimePolicy) await writeFile(join(workspace, "use-python"), "");
    await writeFile(
      join(workspace, "temp-probe.zsh"),
      `set -eu
printf '%s\\n' "$TMPDIR" "$TMPPREFIX" > runtime-temp
/bin/cat <<'PLAIN'
plain-heredoc-ok
PLAIN
printf private > "$TMPDIR/direct-write"
test "$(/bin/cat "$TMPDIR/direct-write")" = private
/bin/rm "$TMPDIR/direct-write"
if /bin/cat ${JSON.stringify(sharedTemp)} 2>/dev/null; then exit 91; fi
if (printf forbidden > ${JSON.stringify(sharedTemp)}) 2>/dev/null; then exit 92; fi
if test -f use-python; then
/usr/bin/python3 - <<'PYTHON'
import os, tempfile
assert tempfile.gettempdir() == os.environ["TMPDIR"]
with tempfile.NamedTemporaryFile() as temporary:
    assert os.path.dirname(temporary.name) == os.environ["TMPDIR"]
print("python-heredoc-and-temp-ok")
PYTHON
fi
`,
    );
    const result = await host.run({
      prompt: "Run the unmodified temporary-storage probe.",
      workspace,
      condition: "passive",
      ...(withRuntimePolicy
        ? {
            runtimePolicy: await loadRuntimeConfiguration(
              join(root, "project"),
            ),
          }
        : {}),
    });
    expect(
      result.finalMessage,
      await readFile(join(workspace, "sandbox-error"), "utf8"),
    ).toBe("ready");
    expect(await readFile(join(workspace, "temp-probe.out"), "utf8")).toBe(
      withRuntimePolicy
        ? "plain-heredoc-ok\npython-heredoc-and-temp-ok\n"
        : "plain-heredoc-ok\n",
    );
    const [temp, prefix] = (
      await readFile(join(workspace, "runtime-temp"), "utf8")
    )
      .trimEnd()
      .split("\n");
    expect(defined(prefix).startsWith(`${defined(temp)}/`)).toBe(true);
    expect(await readFile(sharedTemp, "utf8")).toBe("host-private");
  },
);

test("Codex runtime survives continuation and inherited command children", async () => {
  const { host, workspace } = await codexFixture(
    'if test -f "$HOME/turn-state"; then /bin/sh -c "cat \\"\\$HOME/turn-state\\""; else printf persisted > "$HOME/turn-state"; printf initial; fi; printf "%s" "$HOME" > runtime-home',
  );
  const result = await host.run({
    prompt: "Prepare runtime state.",
    followUpPrompt: "Read it in a child shell.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
    },
  });
  expect(result.finalMessage).toBe("persisted");
  const home = await readFile(join(workspace, "runtime-home"), "utf8");
  expect(home.startsWith(`${workspace}/`)).toBe(false);
  expect(await Bun.file(join(home, "turn-state")).exists()).toBe(false);
}, 30000);

test.each(["NODE_OPTIONS", "TMPPREFIX", "tmpprefix"])(
  "Codex rejects runner-owned environment values in direct runtime requests: %s",
  async (name) => {
    const { host, workspace } = await codexFixture();
    expect(
      host.run({
        prompt: "Return ready.",
        workspace,
        condition: "passive",
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: { [name]: "runner-owned-override" },
          readOnlyRoots: [],
        },
      }),
    ).rejects.toThrow("protected");
  },
);

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
