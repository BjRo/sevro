import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defined } from "../../fixtures/assertions";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import { fixture, invoke } from "../../fixtures/runtime-cli";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test.each([
  [[], "/", "must be object"],
  [
    { format: "sevro.runtime.v1", "extra/~": "PRIVATE_VALUE" },
    "/extra~1~0",
    "must NOT have additional properties",
  ],
  [
    { format: "sevro.runtime.v1", unexpected: "PRIVATE_VALUE" },
    "/unexpected",
    "must NOT have additional properties",
  ],
  [
    { format: "sevro.runtime.v1", network: { localHttp: "PRIVATE_VALUE" } },
    "/network/localHttp",
    "must be boolean",
  ],
  [
    { format: "sevro.runtime.v1", environment: { inherit: [42] } },
    "/environment/inherit/0",
    "must be string",
  ],
  [{}, "/format", "must have required property"],
] as const)(
  "CLI names the runtime schema problem in %j",
  async (configuration, field, problem) => {
    const { project, args } = await fixture(roots);
    const path = join(project, "sevro.json");
    await writeFile(path, JSON.stringify(configuration));
    const run = await invoke(args);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
    const message = defined(run.result.diagnostic).message;
    expect(message).toContain(path);
    expect(message).toContain(field);
    expect(message).toContain(problem);
    expect(message).not.toContain("PRIVATE_VALUE");
  },
);

test.each([false, true])(
  "CLI rejects malformed repository runtime configuration before execution; explicit=%s",
  async (explicit) => {
    const { root, project, args } = await fixture(roots);
    const path = explicit
      ? join(root, "selected-runtime.json")
      : join(project, "sevro.json");
    await writeFile(path, '{"PRIVATE_VALUE":');
    const run = await invoke([
      ...args,
      ...(explicit ? ["--runtime-config-file", path] : []),
    ]);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
    const message = defined(run.result.diagnostic).message;
    expect(message).toContain(path);
    expect(message).toContain("$: invalid JSON");
    expect(message).not.toContain("PRIVATE_VALUE");
  },
);

test.skipIf(process.getuid?.() === 0)(
  "CLI reports operation and path for an unreadable selected PATH directory",
  async () => {
    const { root, project, args } = await fixture(roots);
    const blocked = join(root, "blocked-path");
    await mkdir(blocked);
    await chmod(blocked, 0);
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { inherit: ["PATH"] },
      }),
    );
    try {
      const run = await invoke([...args, "--dry"], { PATH: blocked });
      expect(run.code).toBe(64);
      expect(run.result.diagnostic?.code).toBe("sevro.invocation.invalid");
      expect(run.result.diagnostic?.message).toContain("EACCES");
      expect(run.result.diagnostic?.message).toMatch(
        /filesystem (?:access|lstat|stat|statx|realpath) failed/,
      );
      expect(run.result.diagnostic?.message).toContain(blocked);
    } finally {
      await chmod(blocked, 0o700);
    }
  },
);

test.skipIf(process.getuid?.() === 0)(
  "CLI reports operation and path when an explicit runtime file is inaccessible",
  async () => {
    const { root, args } = await fixture(roots);
    const blocked = join(root, "blocked-config"),
      selected = join(blocked, "runtime.json");
    await mkdir(blocked);
    await chmod(blocked, 0);
    try {
      const run = await invoke([
        ...args,
        "--runtime-config-file",
        selected,
        "--dry",
      ]);
      expect(run.code).toBe(64);
      expect(run.result.diagnostic?.code).toBe("sevro.invocation.invalid");
      expect(run.result.diagnostic?.message).toContain("EACCES");
      expect(run.result.diagnostic?.message).toMatch(
        /filesystem (?:access|lstat|stat|statx|realpath) failed/,
      );
      expect(run.result.diagnostic?.message).toContain(selected);
    } finally {
      await chmod(blocked, 0o700);
    }
  },
);

test.skipIf(process.platform !== "darwin" || process.getuid?.() === 0)(
  "CLI accepts inherited macOS PATH with an inaccessible individual tool alias",
  async () => {
    const { project, args } = await fixture(roots);
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { inherit: ["PATH"] },
      }),
    );
    const run = await invoke([...args, "--dry"], {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
    expect(run.code, JSON.stringify(run.result)).toBe(0);
    expect(run.result.execution.status).toBe("not_run");
  },
);

test("CLI warns when using deprecated toolchain options", async () => {
  const { root, args } = await fixture(roots);
  const bin = join(root, "tools");
  await mkdir(bin);
  const run = await invoke([
    ...args,
    "--shell-isolation",
    "--toolchain-bin-dir",
    bin,
  ]);
  expect(run.code, run.stderr).toBe(0);
  expect(run.stderr).toContain("--toolchain-bin-dir is deprecated");
});

test.each([
  { name: "unsupported schema", policy: { format: "sevro.runtime.v2" } },
  {
    name: "unknown property",
    policy: { format: "sevro.runtime.v1", permissive: true },
  },
  {
    name: "missing inherited value",
    policy: {
      format: "sevro.runtime.v1",
      environment: { inherit: ["SEVRO_RUNTIME_MISSING"] },
    },
  },
  {
    name: "NUL environment value",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { SAMPLE: "a\0b" } },
    },
  },
  {
    name: "oversized UTF8 environment value",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { SAMPLE: "界".repeat(5000) } },
    },
  },
  {
    name: "relative PATH entry",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { PATH: "relative:/usr/bin" } },
    },
  },
  {
    name: "empty PATH entry",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { PATH: "/usr/bin:" } },
    },
  },
  {
    name: "control in PATH",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { PATH: "/usr/bin\n" } },
    },
  },
  {
    name: "non-directory PATH entry",
    policy: {
      format: "sevro.runtime.v1",
      environment: { set: { PATH: "/bin/sh" } },
    },
  },
  {
    name: "missing read root",
    policy: {
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["./missing"] },
    },
  },
  {
    name: "undeclared path variable",
    policy: {
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["${SEVRO_RUNTIME_MISSING}"] },
    },
  },
  {
    name: "invalid path interpolation",
    policy: {
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["${bad-name}"] },
    },
  },
  {
    name: "control in read root",
    policy: {
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["/tmp\u007f"] },
    },
  },
  {
    name: "whole filesystem",
    policy: {
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["/"] },
    },
  },
])("CLI refuses invalid runtime input: $name", async ({ policy }) => {
  const { project, args } = await fixture(roots);
  await writeFile(join(project, "sevro.json"), JSON.stringify(policy));
  const run = await invoke(args, { SEVRO_RUNTIME_MISSING: undefined });
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
});

test("CLI refuses a missing explicit runtime file", async () => {
  const { root, args } = await fixture(roots);
  expect(
    (
      await invoke([
        ...args,
        "--runtime-config-file",
        join(root, "missing.json"),
      ])
    ).code,
  ).toBe(64);
});

test("CLI ignores missing PATH entries and broken tool links", async () => {
  const { root, project, args } = await fixture(roots);
  const bin = join(root, "tools");
  await mkdir(bin);
  await symlink(join(root, "missing-tool"), join(bin, "broken"));
  await symlink(project, join(bin, "directory-link"));
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PATH: `${bin}:${join(root, "missing-bin")}` } },
    }),
  );
  const run = await invoke(args);
  expect(run.code, run.stderr).toBe(0);
});

test("CLI rejects overlapping seed targets", async () => {
  const { root, project, args } = await fixture(roots);
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: {
        seedDirectories: [
          { source, target: "cache" },
          { source, target: "cache" },
        ],
      },
    }),
  );
  expect((await invoke(args)).code).toBe(64);
});

test("CLI rejects cyclic seed directories", async () => {
  const { root, project, args } = await fixture(roots);
  const source = join(root, "seed");
  await mkdir(source);
  await symlink(source, join(source, "cycle"));
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { seedDirectories: [{ source, target: "cache" }] },
    }),
  );
  expect((await invoke(args)).code).toBe(64);
});

test("CLI refuses a seed over the documented byte bound", async () => {
  const { root, project, args } = await fixture(roots);
  const source = join(root, "seed");
  await mkdir(source);
  const large = join(source, "large");
  await writeFile(large, "");
  await truncate(large, 512 * 1024 * 1024 + 1);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { seedDirectories: [{ source, target: "cache" }] },
    }),
  );
  expect((await invoke(args)).code).toBe(64);
});

test("CLI refuses special files in a runtime seed", async () => {
  const { root, project, args } = await fixture(roots);
  const source = join(root, "seed");
  await mkdir(source);
  expect(
    await Bun.spawn(["/usr/bin/mkfifo", join(source, "pipe")], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited,
  ).toBe(0);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { seedDirectories: [{ source, target: "cache" }] },
    }),
  );
  expect((await invoke(args)).code).toBe(64);
});

test("CLI refuses an overfull PATH directory", async () => {
  const { root, project, args } = await fixture(roots);
  const bin = join(root, "tools");
  await mkdir(bin);
  for (let index = 0; index < 4097; index++)
    await writeFile(join(bin, `entry-${index}`), "");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PATH: bin } },
    }),
  );
  expect((await invoke(args)).code).toBe(64);
});

test("CLI refuses mixing selected runtime configuration with legacy toolchain options", async () => {
  const { root, project, args } = await fixture(roots);
  const bin = join(root, "tools");
  await mkdir(bin);
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({ format: "sevro.runtime.v1" }),
  );
  const run = await invoke([
    ...args,
    "--shell-isolation",
    "--toolchain-bin-dir",
    bin,
  ]);
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
});
