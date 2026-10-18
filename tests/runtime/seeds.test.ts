import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCodexHost } from "../../src/hosts/codex";
import { createClaudeHost } from "../../src/hosts/claude";
import { runtimeSeedDigest } from "../../src/runtime/seeds";
import { loadRuntimeConfiguration } from "../../src/engine";
import { defined, parseRecord } from "../fixtures/assertions";
import { createCodexFixture } from "../fixtures/runtime-host-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const codexFixture = createCodexFixture(roots);

test("Codex denies shared-cache sources selected only for another role", async () => {
  const { host, root, workspace } = await codexFixture(
    'if /bin/cat "$CACHE_SOURCE/input" 2>/dev/null; then /bin/echo leaked; else /bin/echo denied; fi',
  );
  const source = await realpath(await mkdtemp(join(root, "checks-cache-")));
  await writeFile(join(source, "input"), "private to checks");
  const result = await host.run({
    prompt: "Probe access.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { CACHE_SOURCE: source },
      readOnlyRoots: [],
      sharedCacheDirectories: [{ source, target: "cache", roles: ["checks"] }],
    },
  });
  expect(result.finalMessage).toBe("denied");
  expect(await readFile(join(source, "input"), "utf8")).toBe(
    "private to checks",
  );
});

test("Codex rejects a shared cache retargeted after configuration load", async () => {
  const { host, root, workspace } = await codexFixture();
  const source = join(root, "cache");
  const replacement = join(root, "replacement");
  await mkdir(source);
  await mkdir(replacement);
  const project = join(root, "project");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: {
        sharedCacheDirectories: [
          { source, target: "cache", roles: ["candidate"] },
        ],
      },
    }),
  );
  const runtimePolicy = await loadRuntimeConfiguration(project);
  await rename(source, join(root, "original"));
  await symlink(replacement, source);
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy,
    }),
  ).rejects.toThrow("canonical directory");
});

test("Codex reuses a shared UV cache across separate native runs without copying", async () => {
  const { host, root, workspace } = await codexFixture(
    '/bin/cat "$UV_CACHE_DIR/input"; /bin/echo warmed > "$UV_CACHE_DIR/input"',
  );
  const source = await realpath(
    await mkdtemp(join(homedir(), ".sevro-shared-codex-cache-")),
  );
  roots.push(source);
  const dependency = join(source, "input");
  await writeFile(dependency, "prepared");
  const original = await stat(dependency);
  const project = join(root, "project");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { UV_CACHE_DIR: "{{sevro.runtime}}/uv-cache" } },
      runtime: {
        sharedCacheDirectories: [
          { source, target: "uv-cache", roles: ["candidate"] },
        ],
      },
    }),
  );
  const runtimePolicy = await loadRuntimeConfiguration(project);
  const request = {
    prompt: "Use the shared cache.",
    workspace,
    condition: "passive" as const,
    runtimePolicy,
  };
  const first = await host.run(request);
  expect(first.finalMessage).toBe("prepared");
  expect(
    first.observations?.find((item) => item.id === "sevro.host.runtime")?.data,
  ).toMatchObject({
    sharedCacheDirectories: [
      { source, target: "uv-cache", roles: ["candidate"] },
    ],
  });
  expect(await readFile(dependency, "utf8")).toBe("warmed\n");
  expect((await host.run(request)).finalMessage).toBe("warmed");
  expect((await stat(dependency)).ino).toBe(original.ino);
});

test("Claude grants its selected shared cache through the native command policy", async () => {
  const { root, workspace } = await codexFixture();
  const source = await realpath(
    await mkdtemp(join(homedir(), ".sevro-shared-claude-cache-")),
  );
  roots.push(source);
  const project = join(root, "project");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { CACHE_SOURCE: source, REAL_HOME: homedir() } },
      runtime: {
        sharedCacheDirectories: [
          { source, target: "cache", roles: ["candidate"] },
        ],
      },
    }),
  );
  const binary = join(root, "claude-cache-policy");
  await writeFile(
    binary,
    `#!${process.execPath}
import { readFileSync } from "node:fs";
const path = process.argv[process.argv.indexOf("--settings") + 1];
const settings = JSON.parse(readFileSync(path, "utf8"));
const source = process.env.CACHE_SOURCE;
const filesystem = settings.sandbox.filesystem;
const receipt = {
  cacheWritable: filesystem.allowWrite.includes(source),
  homeWriteDenied: filesystem.denyWrite.includes(process.env.REAL_HOME),
  cacheEditable: settings.permissions.allow.includes("Edit(/" + source + "/**)"),
};
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(receipt) }));
`,
    { mode: 0o700 },
  );
  const credentialFile = join(root, "claude-credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: project,
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Use the cache.",
    workspace,
    condition: "passive",
    runtimePolicy: await loadRuntimeConfiguration(project),
  });
  expect(result.complete).toBe(true);
  expect(parseRecord(defined(result.finalMessage))).toEqual({
    cacheWritable: true,
    homeWriteDenied: false,
    cacheEditable: true,
  });
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
}, 30000);

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

test("Codex runtime seeds ignore repository-local state planted by the candidate", async () => {
  const { host, workspace, root } = await codexFixture(
    '/bin/cat "$CACHE/input"',
  );
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(join(source, "input"), "trusted");
  const directory = join(workspace, ".git/sevro-runtime/candidate");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "cache"), "not a directory");
  const result = await host.run({
    prompt: "Return ready.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { CACHE: "{{sevro.runtime}}/cache" },
      readOnlyRoots: [],
      seeds: [
        { source, target: "cache", sha256: await runtimeSeedDigest(source) },
      ],
    },
  });
  expect(result.finalMessage).toBe("trusted");
  expect(await readFile(join(directory, "cache"), "utf8")).toBe(
    "not a directory",
  );
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

test("Codex reuses verified dependency bytes while keeping trials and source independent", async () => {
  const { host, root, workspace } = await codexFixture(
    'cat "$PUBLIC_CACHE_DIR/value"; printf candidate > "$PUBLIC_CACHE_DIR/value"',
  );
  const source = join(root, "dependencies");
  await mkdir(source);
  await writeFile(join(source, "value"), "verified");
  const runtimePolicy = {
    format: "sevro.runtime.v1" as const,
    environment: { PUBLIC_CACHE_DIR: "{{sevro.runtime}}/cache" },
    readOnlyRoots: [],
    seeds: [
      { source, target: "cache", sha256: await runtimeSeedDigest(source) },
    ],
  };
  const first = await host.run({
    prompt: "Return dependency",
    workspace,
    condition: "passive",
    runtimePolicy,
  });
  expect(first.finalMessage).toBe("verified");
  expect(await readFile(join(source, "value"), "utf8")).toBe("verified");
  await writeFile(join(source, "value"), "operator replacement");
  const peer = join(root, "peer");
  await mkdir(peer);
  const second = await host.run({
    prompt: "Return dependency",
    workspace: peer,
    condition: "passive",
    runtimePolicy,
  });
  expect(second.finalMessage).toBe("verified");
  expect(await readFile(join(source, "value"), "utf8")).toBe(
    "operator replacement",
  );
}, 60_000);
