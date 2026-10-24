import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defined, parseRunEvidence } from "../../fixtures/assertions";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import { fixture, invoke } from "../../fixtures/runtime-cli";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("CLI refuses runtime access to protected source before candidate execution", async () => {
  const { project, args } = await fixture(roots);
  const bin = join(project, "bin");
  await mkdir(bin);
  await writeFile(
    join(project, "sevro.json"),
    '{"format":"sevro.runtime.v1","environment":{"inherit":["PATH"]}}',
  );
  const run = await invoke(args, { PATH: `${bin}:/usr/bin:/bin` });
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
  expect(run.result.diagnostic?.message).toContain("protected");
});

test.each(["lexical", "canonical"])(
  "CLI protects both optional-root alias boundaries: %s",
  async (kind) => {
    const { root, project, args } = await fixture(roots);
    const support = join(root, "support");
    await mkdir(support);
    const alias =
      kind === "lexical" ? join(project, "escape") : join(root, "alias");
    await symlink(kind === "lexical" ? support : project, alias);
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { optionalReadOnlyRoots: [alias] },
      }),
    );
    const run = await invoke(args);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
    expect(run.result.diagnostic?.message).toContain("protected");
  },
);

test("CLI never queries metadata providers inside protected source", async () => {
  const { root, project, args } = await fixture(roots);
  const bin = join(project, "bin"),
    marker = join(root, "query-ran");
  await mkdir(bin);
  await writeFile(
    join(bin, "brew"),
    `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 8\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PATH: bin } },
    }),
  );
  const run = await invoke(args);
  expect(run.code).toBe(64);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("CLI rejects whole-home PATH before querying a provider", async () => {
  const { root, project, args } = await fixture(roots);
  const home = join(root, "host-home"),
    marker = join(root, "query-ran");
  await mkdir(home);
  await writeFile(
    join(home, "brew"),
    `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 8\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["PATH"] },
    }),
  );
  const run = await invoke(args, { HOME: home, PATH: home });
  expect(run.code).toBe(64);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test.each(["project", "alias", "dangling"])(
  "CLI rejects absent optional roots across protected boundaries: %s",
  async (kind) => {
    const { root, project, args } = await fixture(roots);
    const alias = join(root, "protected-alias");
    await symlink(
      kind === "dangling" ? join(project, "absent") : project,
      alias,
    );
    const missing = join(
      kind === "project" ? project : alias,
      "missing",
      "child",
    );
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { optionalReadOnlyRoots: [missing] },
      }),
    );
    const run = await invoke(args);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
    expect(run.result.diagnostic?.message).toContain("protected");
  },
);

test.each(["present", "absent"])(
  "CLI protects canonical credential directories through unrelated aliases: %s",
  async (kind) => {
    const { root, project, args } = await fixture(roots);
    const home = join(root, "host-home"),
      credentials = join(root, "credential-target"),
      alias = join(root, "innocent-alias");
    await mkdir(home);
    if (kind === "present") await mkdir(credentials);
    await symlink(credentials, join(home, ".ssh"));
    await symlink(credentials, alias);
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { optionalReadOnlyRoots: [alias] },
      }),
    );
    const run = await invoke(args, { HOME: home });
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
  },
);

test("CLI resolves optional home paths without granting the whole home", async () => {
  const { root, project, args } = await fixture(roots);
  const home = join(root, "operator-home"),
    support = join(home, "support");
  await mkdir(support, { recursive: true });
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      filesystem: { optionalReadOnlyRoots: ["~/support"] },
    }),
  );
  const run = await invoke(args, { HOME: home });
  expect(run.code, run.stderr).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(evidence.configuration.redacted.runtimePolicy).toMatchObject({
    readOnlyRoots: [support],
  });
});

test("CLI rejects malformed runtime bytes before executing", async () => {
  const { project, args } = await fixture(roots);
  await writeFile(join(project, "sevro.json"), Buffer.alloc(30000, 0xff));
  const run = await invoke(args);
  expect(run.code).toBe(64);
  expect(run.result.execution.status).toBe("not_run");
});

test.skipIf(process.getuid?.() === 0)(
  "CLI rejects unresolved credential protections under an unreadable home",
  async () => {
    const { root, project, args } = await fixture(roots);
    const home = join(root, "unreadable-home"),
      support = join(root, "support");
    await Promise.all([home, support].map((path) => mkdir(path)));
    await writeFile(
      join(project, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { optionalReadOnlyRoots: [support] },
      }),
    );
    await chmod(home, 0);
    try {
      const run = await invoke(args, { HOME: home });
      expect(run.code).toBe(64);
      expect(run.result.execution.status).toBe("not_run");
    } finally {
      await chmod(home, 0o700);
    }
  },
);

test("CLI identity binds actual optional grants and skipped evidence", async () => {
  const { root, project, args } = await fixture(roots);
  const support = join(root, "support");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      filesystem: { optionalReadOnlyRoots: [support] },
    }),
  );
  const first = await invoke([...args, "--dry"]);
  expect(first.code, first.stderr).toBe(0);
  const before = parseRunEvidence(
    await readFile(defined(first.result.evidencePath), "utf8"),
  );
  expect(before.configuration.redacted.runtimePolicy).toMatchObject({
    readOnlyRoots: [],
    skippedOptionalReadOnlyRoots: [support],
  });
  await mkdir(support);
  const second = await invoke([...args, "--dry"]);
  expect(second.code, second.stderr).toBe(0);
  const after = parseRunEvidence(
    await readFile(defined(second.result.evidencePath), "utf8"),
  );
  expect(after.configuration.redacted.runtimePolicy).toMatchObject({
    readOnlyRoots: [support],
    skippedOptionalReadOnlyRoots: [],
  });
  expect(after.configuration.digest).not.toBe(before.configuration.digest);
});

test("CLI applies declared read-only roots outside PATH", async () => {
  const { root, project, args } = await fixture(roots, [
    {
      id: "runtime",
      grader: "sevro.shell",
      configuration: {
        run: 'cat "$UV_PYTHON_INSTALL_DIR/value"; ! printf changed > "$UV_PYTHON_INSTALL_DIR/value"',
        expectExact: "host python",
      },
    },
  ]);
  const home = join(root, "host-home");
  const python = join(home, "python");
  await mkdir(python, { recursive: true });
  await writeFile(join(python, "value"), "host python\n");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { inherit: ["UV_PYTHON_INSTALL_DIR"] },
      filesystem: { readOnlyRoots: ["${UV_PYTHON_INSTALL_DIR}"] },
    }),
  );
  const run = await invoke([...args, "--shell-isolation"], {
    HOME: home,
    UV_PYTHON_INSTALL_DIR: python,
  });
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(await readFile(join(python, "value"), "utf8")).toBe("host python\n");
});
