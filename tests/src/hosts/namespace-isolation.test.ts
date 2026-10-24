import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluation } from "../../../src/engine";
import { createClaudeHost } from "../../../src/hosts/claude";
import { createCodexHost } from "../../../src/hosts/codex";
import { allocateNativeState } from "../../../src/native-transcript-state";
import { defined } from "../../fixtures/assertions";
import { syntheticClaudeLogin } from "../../fixtures/claude-login";
import { createTemporaryFixtures, fixtureGit } from "../../fixtures/filesystem";
import {
  createCodexFixture,
  waitForNativeCommand,
} from "../../fixtures/runtime-host-fixtures";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const codexFixture = createCodexFixture(roots);

function runtimeFailureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

test.each([
  { native: "Claude", viaAlias: false },
  { native: "Claude", viaAlias: true },
  { native: "Codex", viaAlias: false },
  { native: "Codex", viaAlias: true },
])(
  "$native runtime refuses a fixture within the native namespace: alias $viaAlias",
  async ({ native, viaAlias }) => {
    const { root, host: codexHost } = await codexFixture(
      "printf launched > native-launched",
    );
    const privateFixture = await allocateNativeState("runtime-fixture-");
    roots.push(privateFixture);
    const workspace = join(privateFixture, "workspace");
    await mkdir(workspace);
    expect(await fixtureGit(workspace, "init", "--quiet")).toBe("");
    const gitEntries = await readdir(join(workspace, ".git"));
    const peerFile = join(privateFixture, "retained-peer.json");
    await writeFile(peerFile, "retained peer");
    const privateEntries = await readdir(privateFixture);
    const alias = join(root, "workspace-alias");
    await symlink(workspace, alias);
    const binary = join(root, "claude-namespace-fixture");
    await writeFile(
      binary,
      '#!/bin/sh\nprintf launched > native-launched\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, syntheticClaudeLogin());
    const host =
      native === "Codex"
        ? codexHost
        : createClaudeHost({
            binary,
            credentialFile,
            model: "synthetic",
            effort: "low",
            projectRoot: join(root, "project"),
            resultsRoot: join(root, "results"),
            additionalProtectedRoots: [],
          });
    const running = host.run({
      prompt: "Use external runtime.",
      workspace: viaAlias ? alias : workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
      },
    });
    expect(running).rejects.toThrow(
      "native runtime namespace overlaps the fixture workspace",
    );
    await running.catch(() => undefined);
    expect(await Bun.file(join(workspace, "native-launched")).exists()).toBe(
      false,
    );
    expect(await readdir(join(workspace, ".git"))).toEqual(gitEntries);
    expect(await readdir(privateFixture)).toEqual(privateEntries);
    expect(await readFile(peerFile, "utf8")).toBe("retained peer");
  },
);

test.skipIf(process.platform !== "darwin").each([
  { native: "Claude", viaAlias: false },
  { native: "Claude", viaAlias: true },
  { native: "Codex", viaAlias: false },
  { native: "Codex", viaAlias: true },
])(
  "$native runtime refuses a namespace within the fixture: alias $viaAlias",
  async ({ native, viaAlias }) => {
    const { root, workspace, bin } = await codexFixture(
      "printf launched > native-launched",
    );
    expect(await fixtureGit(workspace, "init", "--quiet")).toBe("");
    const gitEntries = await readdir(join(workspace, ".git"));
    const namespace = join(workspace, "sevro-native-private");
    const peer = join(namespace, "claude-peer", "runtime", "home");
    await mkdir(peer, { recursive: true, mode: 0o700 });
    const peerFile = join(peer, "review.json");
    await writeFile(peerFile, "retained peer");
    const alias = join(root, "workspace-alias");
    await symlink(workspace, alias);
    const binary = join(bin, "claude-workspace-runtime");
    await writeFile(
      binary,
      '#!/bin/sh\nprintf launched > native-launched\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, syntheticClaudeLogin());
    const codexBinary = join(bin, "candidate");
    await cp(join(root, "candidate"), codexBinary);
    const host =
      native === "Codex"
        ? createCodexHost({
            binary: codexBinary,
            sandboxBinary: defined(Bun.which("codex")),
            authFile: join(root, "auth.json"),
            model: "synthetic",
            effort: "low",
            projectRoot: join(root, "project"),
            resultsRoot: join(root, "results"),
            additionalProtectedRoots: [],
          })
        : createClaudeHost({
            binary,
            credentialFile,
            model: "synthetic",
            effort: "low",
            projectRoot: join(root, "project"),
            resultsRoot: join(root, "results"),
            additionalProtectedRoots: [],
          });
    const originalTemp = process.env.TMPDIR;
    process.env.TMPDIR = viaAlias ? alias : workspace;
    try {
      const running = host.run({
        prompt: "Use external runtime.",
        workspace,
        condition: "passive",
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
        },
      });
      expect(running).rejects.toThrow(
        "native runtime namespace overlaps the fixture workspace",
      );
      await running.catch(() => undefined);
      expect(await Bun.file(join(workspace, "native-launched")).exists()).toBe(
        false,
      );
      expect(await readdir(join(workspace, ".git"))).toEqual(gitEntries);
      expect(await readdir(namespace)).toEqual(["claude-peer"]);
      expect(await readFile(peerFile, "utf8")).toBe("retained peer");
    } finally {
      if (originalTemp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTemp;
    }
  },
  30000,
);

test.skipIf(process.platform !== "darwin").each([false, true])(
  "Claude runtime refuses a namespace within implicit native temp writes: alias %s",
  async (viaAlias) => {
    const { root, workspace } = await codexFixture();
    const unsafeTemp = join(
      "/tmp/claude",
      `sevro-runtime-probe-${randomUUID()}`,
    );
    await mkdir(unsafeTemp, { recursive: true, mode: 0o700 });
    roots.push(unsafeTemp);
    const aliasContainer = await temporaryFixture(
      join(tmpdir(), "sevro-runtime-alias-"),
    );

    const alias = join(aliasContainer, "temp");
    await symlink(unsafeTemp, alias);
    const binary = join(root, "claude-unsafe-runtime");
    await writeFile(
      binary,
      '#!/bin/sh\nprintf launched > native-launched\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, syntheticClaudeLogin());
    const host = createClaudeHost({
      binary,
      credentialFile,
      model: "synthetic",
      effort: "low",
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [],
    });
    const originalTemp = process.env.TMPDIR;
    process.env.TMPDIR = viaAlias ? alias : unsafeTemp;
    try {
      const running = host.run({
        prompt: "Use external runtime.",
        workspace,
        condition: "passive",
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
        },
      });
      expect(running).rejects.toThrow("implicit native writable root");
      await running.catch(() => undefined);
      expect(await Bun.file(join(workspace, "native-launched")).exists()).toBe(
        false,
      );
    } finally {
      if (originalTemp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTemp;
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "Claude managed workspace refuses implicit native temp writes without a runtime policy",
  async () => {
    const { root } = await codexFixture();
    const unsafeTemp = join(
      "/tmp/claude",
      `sevro-workspace-probe-${randomUUID()}`,
    );
    await mkdir(unsafeTemp, { recursive: true, mode: 0o700 });
    roots.push(unsafeTemp);
    const binary = join(root, "claude-unsafe-workspace");
    await writeFile(
      binary,
      '#!/bin/sh\nprintf launched > native-launched\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, syntheticClaudeLogin());
    const host = createClaudeHost({
      binary,
      credentialFile,
      model: "synthetic",
      effort: "low",
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [],
    });
    let workspace = "";
    const originalTemp = process.env.TMPDIR;
    process.env.TMPDIR = unsafeTemp;
    try {
      const { result } = await runEvaluation({
        projectRoot: join(root, "project"),
        resultsRoot: join(root, "results"),
        runnerBuildDigest: "a".repeat(64),
        projectDigest: "b".repeat(64),
        condition: "passive",
        trialCount: 1,
        passThreshold: 1,
        host: {
          ...host,
          run(request) {
            workspace = request.workspace;
            return host.run(request);
          },
        },
        case: {
          id: "unsafe-workspace",
          prompt: "Return ready",
          fixture: { files: {} },
          checks: [],
          requiredEvidence: [],
        },
      });
      expect(result.execution.status).toBe("failed");
      expect(await Bun.file(join(workspace, "native-launched")).exists()).toBe(
        false,
      );
    } finally {
      if (originalTemp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTemp;
    }
  },
);

function expectedRuntimeFailure(
  native: string,
  ending: string,
): string | boolean {
  if (ending === "failure")
    return native === "Codex" ? "Codex event stream has no thread start" : true;
  return `${native} run ${runtimeEnding(ending)}`;
}

function runtimeEnding(ending: string): string {
  return ending === "timeout" ? "timed out after 0.5 s" : "cancelled";
}

test.each([
  { native: "Codex", ending: "failure" },
  { native: "Codex", ending: "timeout" },
  { native: "Codex", ending: "cancel" },
  { native: "Claude", ending: "failure" },
  { native: "Claude", ending: "timeout" },
  { native: "Claude", ending: "cancel" },
])(
  "$native removes external runtime after $ending",
  async ({ native, ending }) => {
    const fixture = await codexFixture("probe", [], 500);
    const binary = join(fixture.root, "candidate");
    await writeFile(
      binary,
      `#!/bin/sh
mkdir -p "$RUNTIME_ROOT/home"
printf artifact > "$RUNTIME_ROOT/home/state"
printf "%s" "$RUNTIME_ROOT" > runtime-root
${ending === "failure" ? "exit 1" : "/bin/sleep 20"}
`,
      { mode: 0o700 },
    );
    let host = fixture.host;
    if (native === "Claude") {
      const credentialFile = join(fixture.root, "claude-credential.json");
      await writeFile(credentialFile, syntheticClaudeLogin());
      host = createClaudeHost({
        binary,
        credentialFile,
        model: "synthetic",
        effort: "low",
        projectRoot: join(fixture.root, "project"),
        resultsRoot: join(fixture.root, "results"),
        additionalProtectedRoots: [],
        timeoutMs: 500,
      });
    }
    const controller = new AbortController();
    const running = host.run({
      prompt: "Allocate private runtime state.",
      workspace: fixture.workspace,
      condition: "passive",
      signal: controller.signal,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { RUNTIME_ROOT: "{{sevro.runtime}}" },
        readOnlyRoots: [],
      },
    });
    const outcome = running.then(
      (result) => result.executionFailed,
      runtimeFailureMessage,
    );
    await waitForNativeCommand(join(fixture.workspace, "runtime-root"));
    if (ending === "cancel") controller.abort();
    expect(await outcome).toBe(expectedRuntimeFailure(native, ending));
    const runtime = await readFile(
      join(fixture.workspace, "runtime-root"),
      "utf8",
    );
    expect(runtime.startsWith(`${fixture.workspace}/`)).toBe(false);
    expect(await Bun.file(join(runtime, "home/state")).exists()).toBe(false);
  },
  30000,
);
