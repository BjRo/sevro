import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClaudeHost } from "../src/hosts/claude";
import { createCodexHost } from "../src/hosts/codex";
import { defined } from "./fixtures/assertions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.skipIf(process.env.SEVRO_LIVE_CLAUDE !== "1")(
  "live Claude native goal completes with existing subscription authentication",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sevro-live-runtime-")),
    );
    roots.push(root);
    const workspace = join(root, "workspace"),
      projectRoot = join(root, "project"),
      resultsRoot = join(root, "results");
    await Promise.all(
      [workspace, projectRoot, resultsRoot].map((path) => mkdir(path)),
    );
    const host = createClaudeHost({
      binary: defined(Bun.which("claude")),
      model: "sonnet",
      effort: "low",
      projectRoot,
      resultsRoot,
      additionalProtectedRoots: [],
      timeoutMs: 90000,
    });
    const policy = {
      format: "sevro.runtime.v1" as const,
      environment: {},
      readOnlyRoots: [],
      hooks: { nativeGoal: true, plugins: [] },
    };
    const result = await host.run({
      prompt:
        "/goal The final assistant response is exactly ready. Reply ready now.",
      workspace,
      condition: "passive",
      runtimePolicy: policy,
    });
    expect(result.complete).toBe(true);
    const goal = result.observations?.find(
      (observation) => observation.id === "sevro.host.native-goal",
    );
    expect(goal?.completeness).toBe("complete");
    expect(goal?.data.goalStatus).toBe("complete");
  },
  100000,
);

test.skipIf(process.env.SEVRO_LIVE_CODEX !== "1")(
  "live Codex native goal completes with existing subscription authentication",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sevro-live-codex-goal-")),
    );
    roots.push(root);
    const workspace = join(root, "workspace"),
      projectRoot = join(root, "project"),
      resultsRoot = join(root, "results");
    await Promise.all(
      [workspace, projectRoot, resultsRoot].map((path) => mkdir(path)),
    );
    const authFile = join(
      process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      "auth.json",
    );
    const host = createCodexHost({
      binary: defined(Bun.which("codex")),
      authFile,
      model: "gpt-6-luna",
      effort: "low",
      entrypoint: "app-server",
      projectRoot,
      resultsRoot,
      additionalProtectedRoots: [authFile],
      timeoutMs: 90000,
    });
    const result = await host.run({
      prompt:
        "Create one native goal with objective: The final assistant reply is exactly ready. Complete that goal and reply ready. Do not launch agents or use shell commands.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        hooks: { nativeGoal: true },
      },
    });
    expect(result.complete, JSON.stringify(result.observations)).toBe(true);
    const goal = result.observations?.find(
      (row) => row.id === "sevro.host.native-goal",
    );
    expect(goal?.data.goalStatus).toBe("complete");
    expect(result.finalMessage).toBe("ready");
  },
  100000,
);

test.skipIf(process.env.SEVRO_LIVE_CLAUDE !== "1")(
  "live Claude Read can inspect a declared read-only runtime root",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sevro-live-read-")),
    );
    const support = await realpath(
      await mkdtemp(join(homedir(), ".sevro-live-read-")),
    );
    roots.push(root, support);
    const workspace = join(root, "workspace"),
      projectRoot = join(root, "project"),
      resultsRoot = join(root, "results");
    await Promise.all(
      [workspace, projectRoot, resultsRoot].map((path) => mkdir(path)),
    );
    await writeFile(join(support, "library.txt"), "runtime support");
    const host = createClaudeHost({
      binary: defined(Bun.which("claude")),
      model: "sonnet",
      effort: "low",
      projectRoot,
      resultsRoot,
      additionalProtectedRoots: [],
      timeoutMs: 90000,
    });
    const result = await host.run({
      prompt: `Use the Read tool to read ${join(support, "library.txt")}. Reply exactly with its contents. If Read is denied, report the failure and stop; do not use Bash or try another path.`,
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [support],
      },
    });
    expect(result.finalMessage).toBe("runtime support");
  },
  100000,
);

test.skipIf(process.env.SEVRO_LIVE_CLAUDE !== "1")(
  "live Claude can read declared runtime support under the real home",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sevro-live-support-")),
    );
    const support = await realpath(
      await mkdtemp(join(homedir(), ".sevro-live-support-")),
    );
    roots.push(root, support);
    const workspace = join(root, "workspace"),
      projectRoot = join(root, "project"),
      resultsRoot = join(root, "results");
    await Promise.all(
      [workspace, projectRoot, resultsRoot].map((path) => mkdir(path)),
    );
    await writeFile(join(support, "library.txt"), "runtime support");
    const host = createClaudeHost({
      binary: defined(Bun.which("claude")),
      model: "sonnet",
      effort: "low",
      projectRoot,
      resultsRoot,
      additionalProtectedRoots: [],
      timeoutMs: 90000,
    });
    const result = await host.run({
      prompt: `Use Bash to execute exactly: /bin/cat ${JSON.stringify(join(support, "library.txt"))} > support.txt. Then reply ready. If it fails, report the failure and stop; do not repair the environment.`,
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [support],
      },
    });
    expect(
      await Bun.file(join(workspace, "support.txt")).text(),
      result.finalMessage ?? "",
    ).toBe("runtime support");
  },
  100000,
);

test.skipIf(process.env.SEVRO_LIVE_CLAUDE !== "1")(
  "live Claude can execute the existing mise Node installation",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sevro-live-node-")),
    );
    roots.push(root);
    const workspace = join(root, "workspace"),
      projectRoot = join(root, "project"),
      resultsRoot = join(root, "results");
    await Promise.all(
      [workspace, projectRoot, resultsRoot].map((path) => mkdir(path)),
    );
    const node = await realpath(defined(Bun.which("node")));
    const versionProcess = Bun.spawn([node, "--version"], { stdout: "pipe" });
    const version = (await new Response(versionProcess.stdout).text()).trim();
    await versionProcess.exited;
    const host = createClaudeHost({
      binary: defined(Bun.which("claude")),
      model: "sonnet",
      effort: "low",
      projectRoot,
      resultsRoot,
      additionalProtectedRoots: [],
      timeoutMs: 90000,
    });
    const result = await host.run({
      prompt:
        'Use Bash to execute exactly: node -e \'require("fs").writeFileSync("node-version.txt", process.version)\'. Then reply ready. If it fails, report the failure and stop; do not repair the environment.',
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { PATH: `${dirname(node)}:/usr/bin:/bin` },
        readOnlyRoots: [dirname(dirname(node))],
      },
    });
    expect(result.complete).toBe(true);
    expect(await readFile(join(workspace, "node-version.txt"), "utf8")).toBe(
      version,
    );
  },
  100000,
);
