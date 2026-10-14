import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCodexHost } from "../../src/hosts/codex";
import { createClaudeHost } from "../../src/hosts/claude";
import { runtimeSeedDigest } from "../../src/runtime/seeds";
import { defined } from "../fixtures/assertions";
import { createCodexFixture } from "../fixtures/runtime-host-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const codexFixture = createCodexFixture(roots);

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
