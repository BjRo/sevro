import { afterEach, expect, test } from "bun:test";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolationPolicy } from "../../../src/isolation/index";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

test("isolation policy canonicalizes command paths and separates access grants", async () => {
  const root = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-policy-")),
  );
  const workspace = join(root, "workspace"),
    source = join(root, "source"),
    state = join(root, "state");
  const runtime = join(state, "runtime"),
    tools = join(root, "tools");
  await Promise.all(
    [workspace, source, runtime, tools].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await symlink(source, join(root, "source-alias"));
  const policy = await createIsolationPolicy({
    workspace,
    privateStateRoot: state,
    protectedRoots: [join(root, "source-alias"), source],
    readOnlyRoots: [tools],
    writableRuntimeRoot: runtime,
    network: "deny",
  });
  expect(policy).toEqual({
    subject: "command",
    workspace,
    privateStateRoot: state,
    deny: [source, state],
    read: {
      runtime: [tools],
      transcripts: [],
      artifacts: [],
      hooks: [],
      plugins: [],
      executables: [],
      native: [],
    },
    write: {
      runtime,
      caches: [],
      native: [],
      home: undefined,
      temp: undefined,
    },
    network: "deny",
    runtimeDeclared: false,
    hooksEnabled: false,
    hideProcessInfo: false,
  });
});

test("host isolation policy retains named grants without requiring future native files", async () => {
  const policy = await createIsolationPolicy({
    subject: "host",
    workspace: "/workspace",
    privateStateRoot: "/state",
    protectedRoots: ["/source"],
    commandHome: "/state/home",
    commandTemp: "/state/tmp",
    executableReadRoots: ["/tools"],
    pluginReadRoots: ["/state/plugins"],
    nativeReadRoots: ["/state/view"],
    nativeWriteRoots: ["/state/skills"],
    network: "local-http",
  });
  expect(policy).toMatchObject({
    subject: "host",
    deny: ["/source"],
    network: "local-http",
    read: {
      executables: ["/tools"],
      plugins: ["/state/plugins"],
      native: ["/state/view"],
    },
    write: {
      home: "/state/home",
      temp: "/state/tmp",
      native: ["/state/skills"],
    },
  });
});

test("isolation policy applies role seed denials, cache access, and local HTTP together", async () => {
  const root = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-policy-runtime-")),
  );
  const cache = join(root, "cache");
  await mkdir(cache);
  const policy = await createIsolationPolicy({
    subject: "host",
    workspace: "/workspace",
    privateStateRoot: "/state",
    protectedRoots: ["/source"],
    network: "deny",
    runtimeRole: "candidate",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: ["/tools"],
      seedReadDenyRoots: ["/seed"],
      network: { localHttp: true },
      hooks: { plugins: ["probe"] },
      sharedCacheDirectories: [
        { source: cache, target: "cache", roles: ["candidate"] },
        { source: "/hooks-cache", target: "hooks-cache", roles: ["hooks"] },
      ],
    },
  });
  expect(policy).toMatchObject({
    deny: ["/source", "/seed", "/hooks-cache"],
    read: { runtime: ["/tools"] },
    write: { caches: [cache] },
    network: "local-http",
    runtimeDeclared: true,
    hooksEnabled: true,
  });
});

test("hook isolation policy expresses process privacy without renderer text from callers", async () => {
  const root = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-policy-hook-")),
  );
  const workspace = join(root, "workspace"),
    state = join(root, "state");
  await mkdir(workspace);
  const policy = await createIsolationPolicy({
    subject: "hook",
    workspace,
    privateStateRoot: state,
    protectedRoots: [root + "/source"],
    protectedRootsCanonical: true,
    network: "deny",
  });
  expect(policy.hideProcessInfo).toBe(true);
});

test("isolation policy discovers evaluator protection from a description", async () => {
  const root = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-policy-evaluation-")),
  );
  const workspace = join(root, "workspace"),
    source = join(root, "source"),
    results = join(root, "results");
  await Promise.all([workspace, source, results].map((path) => mkdir(path)));
  const policy = await createIsolationPolicy({
    subject: "host",
    workspace,
    privateStateRoot: join(root, "state"),
    protection: {
      projectRoot: source,
      resultsRoot: results,
      additionalRoots: [],
    },
  });
  expect(policy.deny).toContain(source);
  expect(policy.deny).toContain(results);
  expect(policy.deny).not.toContain(workspace);
});

test("evaluation isolation policy protects preparation, fixture source, and run state", async () => {
  const root = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-policy-sources-")),
  );
  const workspace = join(root, "workspace"),
    source = join(root, "source"),
    runStateRoot = join(root, "run-state"),
    preparationRoot = join(root, "preparation"),
    repositoryRoot = join(root, "repository");
  await Promise.all(
    [workspace, source, runStateRoot, preparationRoot, repositoryRoot].map(
      (path) => mkdir(path),
    ),
  );
  const policy = await createIsolationPolicy({
    subject: "host",
    workspace,
    privateStateRoot: join(root, "private"),
    protection: {
      projectRoot: source,
      resultsRoot: source,
      additionalRoots: [],
      runStateRoot,
      preparationRoot,
      repositoryRoot,
    },
  });
  expect(policy.deny).toContain(runStateRoot);
  expect(policy.deny).toContain(preparationRoot);
  expect(policy.deny).toContain(repositoryRoot);
});

test("explicit allowed network mode preserves native host networking", async () => {
  const policy = await createIsolationPolicy({
    subject: "host",
    workspace: "/workspace",
    privateStateRoot: "/state",
    protectedRoots: ["/source"],
    network: "allowed",
    runtimeRole: "candidate",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      network: { localHttp: true },
    },
  });
  expect(policy.network).toBe("allowed");
});
