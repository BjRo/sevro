import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defined, parseRunEvidence } from "../../fixtures/assertions";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import {
  conflictingCacheSource,
  fixture,
  invoke,
} from "../../fixtures/runtime-cli";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("CLI binds shared-cache declarations but not mutable cache contents to identity", async () => {
  const { root, project, args } = await fixture(roots);
  const source = join(root, "public-cache");
  await mkdir(source);
  const large = join(source, "prepared-dependency");
  await writeFile(large, "");
  await truncate(large, 512 * 1024 * 1024 + 1);
  const path = join(project, "sevro.json");
  const configuration = {
    format: "sevro.runtime.v1",
    runtime: {
      sharedCacheDirectories: [
        { source, target: "cache", roles: ["candidate"] },
      ],
    },
  };
  await writeFile(path, JSON.stringify(configuration));
  const first = await invoke([...args, "--dry"]);
  expect(first.code, first.stderr).toBe(0);
  const before = parseRunEvidence(
    await readFile(defined(first.result.evidencePath), "utf8"),
  );
  await writeFile(join(source, "mutable"), "warmed dependency");
  const second = await invoke([...args, "--dry"]);
  expect(second.code, second.stderr).toBe(0);
  const after = parseRunEvidence(
    await readFile(defined(second.result.evidencePath), "utf8"),
  );
  expect(after.configuration.digest).toBe(before.configuration.digest);
  expect(after.configuration.redacted.runtimePolicy).toMatchObject(
    configuration.runtime,
  );
  configuration.runtime.sharedCacheDirectories[0] = {
    source,
    target: "cache",
    roles: ["candidate", "hooks"],
  };
  await writeFile(path, JSON.stringify(configuration));
  const changed = await invoke([...args, "--dry"]);
  expect(changed.code, changed.stderr).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(changed.result.evidencePath), "utf8"),
  );
  expect(evidence.configuration.digest).not.toBe(before.configuration.digest);
});

test.each([
  { target: "cache" },
  { target: "cache", roles: [] },
  { target: "cache", roles: ["candidate", "candidate"] },
  { target: "cache", roles: ["unknown"] },
  { target: "home", roles: ["candidate"] },
  { target: "tmp", roles: ["candidate"] },
  { target: "../cache", roles: ["candidate"] },
])("CLI refuses invalid shared-cache declarations: %j", async (declaration) => {
  const { root, project, args } = await fixture(roots);
  const source = join(root, "public-cache");
  await mkdir(source);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { sharedCacheDirectories: [{ source, ...declaration }] },
    }),
  );
  const result = await invoke([...args, "--dry"]);
  expect(result.code).toBe(64);
  expect(result.result.evidencePath).toBeNull();
});

test.each([
  "project",
  "results",
  "credential",
  "broad",
  "file",
  "readonly",
  "slot-collision",
  "duplicate-source",
])("CLI refuses conflicting shared-cache sources: %s", async (kind) => {
  const { root, project, args } = await fixture(roots);
  const cache = join(root, "cache");
  await mkdir(cache);
  const source = await conflictingCacheSource(kind, root, project, cache);
  const entry = { source, target: "cache", roles: ["candidate"] };
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: {
        sharedCacheDirectories:
          kind === "duplicate-source"
            ? [entry, { ...entry, target: "other" }]
            : [entry],
        ...(kind === "slot-collision"
          ? { seedDirectories: [{ source: project, target: "cache" }] }
          : {}),
      },
    }),
  );
  try {
    const result = await invoke([...args, "--dry"]);
    expect(result.code).toBe(64);
    expect(result.result.evidencePath).toBeNull();
  } finally {
    if (kind === "readonly") await chmod(cache, 0o700);
  }
});

test("CLI rejects shared caches that overlap declared read-only inputs", async () => {
  const { root, project, args } = await fixture(roots);
  const source = join(root, "public-cache");
  await mkdir(source);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: [source] },
      runtime: {
        sharedCacheDirectories: [
          { source, target: "cache", roles: ["candidate"] },
        ],
      },
    }),
  );
  const result = await invoke([...args, "--dry"]);
  expect(result.code).toBe(64);
  expect(result.result.evidencePath).toBeNull();
});

test("CLI snapshots local HTTP opt-in and binds evaluation identity", async () => {
  const { project, args } = await fixture(roots);
  const path = join(project, "sevro.json");
  await writeFile(path, JSON.stringify({ format: "sevro.runtime.v1" }));
  const disabled = await invoke([...args, "--dry"]);
  expect(disabled.code, disabled.stderr).toBe(0);
  const first = parseRunEvidence(
    await readFile(defined(disabled.result.evidencePath), "utf8"),
  );
  await writeFile(
    path,
    JSON.stringify({
      format: "sevro.runtime.v1",
      network: { localHttp: true },
    }),
  );
  const enabled = await invoke([...args, "--dry"]);
  expect(enabled.code, enabled.stderr).toBe(0);
  const second = parseRunEvidence(
    await readFile(defined(enabled.result.evidencePath), "utf8"),
  );
  expect(second.configuration.redacted.runtimePolicy).toMatchObject({
    network: { localHttp: true },
  });
  expect(second.configuration.digest).not.toBe(first.configuration.digest);
});

test("CLI refuses lexical native seed aliases before hashing public targets", async () => {
  const { root, project, args } = await fixture(roots);
  const namespace = join(
    process.platform === "linux" ? "/var/tmp" : tmpdir(),
    "sevro-native-private",
  );
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  const privateRoot = await temporaryFixture(
    join(namespace, "seed-alias-probe-"),
  );

  const source = join(root, "public-cache");
  await mkdir(source);
  await writeFile(join(source, "value"), "public dependency");
  const alias = join(privateRoot, "public-alias");
  await symlink(source, alias);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      nativeTranscripts: true,
      runtime: { seedDirectories: [{ source: alias, target: "cache" }] },
    }),
  );
  const result = await invoke([...args, "--dry"]);
  expect(result.code).toBe(64);
  expect(result.result.evidencePath).toBeNull();
  expect(await readFile(join(source, "value"), "utf8")).toBe(
    "public dependency",
  );
});

test.each(["seed", "read"])(
  "CLI refuses runner native state as public seed input: %s",
  async (kind) => {
    const { root, project, args } = await fixture(roots);
    const namespace = join(
      process.platform === "linux" ? "/var/tmp" : tmpdir(),
      "sevro-native-private",
    );
    await mkdir(namespace, { recursive: true, mode: 0o700 });
    const source = await realpath(
      await temporaryFixture(join(namespace, "seed-probe-")),
    );

    await writeFile(join(source, "private.txt"), "peer private input");
    const alias = join(root, "native-state-alias");
    await symlink(source, alias);
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        nativeTranscripts: true,
        ...(kind === "seed"
          ? {
              runtime: {
                seedDirectories: [{ source: alias, target: "cache" }],
              },
            }
          : { filesystem: { readOnlyRoots: [alias] } }),
      }),
    );
    const result = await invoke([...args, "--dry"]);
    expect(result.code).toBe(64);
    expect(result.result.evidencePath).toBeNull();
    expect(await readFile(join(source, "private.txt"), "utf8")).toBe(
      "peer private input",
    );
  },
);

test("CLI snapshots explicit native transcript opt-in and binds identity", async () => {
  const { project, args } = await fixture(roots);
  const path = join(project, "sevro.json");
  await writeFile(
    path,
    JSON.stringify({ format: "sevro.runtime.v1", nativeTranscripts: true }),
  );
  const enabled = await invoke([...args, "--dry"]);
  expect(enabled.code, enabled.stderr).toBe(0);
  const first = parseRunEvidence(
    await readFile(defined(enabled.result.evidencePath), "utf8"),
  );
  expect(first.configuration.redacted.runtimePolicy).toMatchObject({
    nativeTranscripts: true,
  });
  await writeFile(
    path,
    JSON.stringify({ format: "sevro.runtime.v1", nativeTranscripts: false }),
  );
  const disabled = await invoke([...args, "--dry"]);
  expect(disabled.code, disabled.stderr).toBe(0);
  const second = parseRunEvidence(
    await readFile(defined(disabled.result.evidencePath), "utf8"),
  );
  expect(second.configuration.digest).not.toBe(first.configuration.digest);
});
