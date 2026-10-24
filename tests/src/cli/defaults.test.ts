import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import baseline from "../../../examples/basic/graded.json";
import { parseInvocation } from "../../../src/cli/invocation";
import {
  defined,
  parseCliResult,
  parseRunEvidence,
} from "../../fixtures/assertions";
import { adapter, cli, git } from "../../fixtures/cli-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

async function project() {
  const root = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-cli-defaults-")),
  );

  await writeFile(join(root, "case.json"), JSON.stringify(baseline));
  return root;
}

async function run(
  root: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
  entrypoint: string[] = [cli],
) {
  const child = Bun.spawn([process.execPath, ...entrypoint, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SEVRO_TEST_SCENARIO: "pass", ...environment },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("native and shell routes protect the complete private extension input closure", async () => {
  const root = await project();
  const manifest = join(root, "run.json");
  await writeFile(
    manifest,
    JSON.stringify({ format: "sevro.run.v1", settings: {} }),
  );
  const privateFiles: [string, string][] = [
    ["run-manifest-file", manifest],
    ["extension-command-file", join(root, "command.json")],
    ["extension-source-file", join(root, "source-a.ts")],
    ["extension-source-file", join(root, "source-b.ts")],
    ["extension-configuration-file", join(root, "private.json")],
    ["extension-redacted-configuration-file", join(root, "redacted.json")],
    ["case-source-root", join(root, "sources")],
    ["case-source-map-file", join(root, "map.json")],
    ["runtime-config-file", join(root, "runtime.json")],
    ["codex-auth-file", join(root, "auth.json")],
    ["claude-credential-file", join(root, "credential.json")],
  ];
  const invocation = await parseInvocation([
    "run",
    "--host",
    "claude",
    "--claude-bin",
    process.execPath,
    "--model",
    "candidate",
    "--effort",
    "low",
    "--semantic-host",
    "codex",
    "--semantic-model",
    "semantic",
    "--semantic-effort",
    "high",
    "--advisory-host",
    "codex",
    "--advisory-model",
    "advisory",
    "--advisory-effort",
    "medium",
    "--codex-bin",
    process.execPath,
    "--project-root",
    root,
    "--results-root",
    join(root, "results"),
    "--protected-root",
    join(root, "extra-private"),
    "--shell-isolation",
    "--case-id",
    "private-extension",
    ...privateFiles.flatMap(([name, path]) => [
      `--${defined(name)}`,
      defined(path),
    ]),
  ]);
  const expected = [
    root,
    join(root, "extra-private"),
    ...privateFiles.map(([, path]) => path),
  ];
  for (const path of expected) {
    expect(defined(invocation.claude).additionalProtectedRoots).toContain(path);
    expect(
      defined(invocation.semanticCodex).additionalProtectedRoots,
    ).toContain(path);
    expect(
      defined(invocation.advisoryCodex).additionalProtectedRoots,
    ).toContain(path);
    expect(defined(invocation.shellIsolation).protectedRoots).toContain(path);
  }
});

test("ordinary run defaults assess one passive trial with all trials required to pass", async () => {
  const root = await project();
  const result = await run(root, [
    "run",
    "--json",
    "--case-file",
    join(root, "case.json"),
    "--adapter-module",
    adapter,
  ]);
  expect(result.code, result.stderr).toBe(0);
  const parsed = parseCliResult(result.stdout);
  expect(parsed.task.verdict).toBe("passed");
  expect(defined(parsed.evidencePath)).toStartWith(
    join(root, ".sevro", "results"),
  );
  const evidence = parseRunEvidence(
    await readFile(defined(parsed.evidencePath), "utf8"),
  );
  expect(evidence.evaluationIdentity.dimensions).toMatchObject({
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(evidence.configuration.redacted.jobs).toBe(3);
});

test.each(["codex", "claude"] as const)(
  "selected %s host resolves PATH once and retains the executable with an explicit override",
  async (host) => {
    const root = await project();
    const bin = join(root, "bin");
    await mkdir(bin);
    const binary = join(bin, host);
    const override = join(bin, "override");
    await writeFile(binary, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    await writeFile(override, "#!/bin/sh\nexit 98\n", { mode: 0o700 });
    await writeFile(join(root, "auth.json"), "test-only-auth");
    const args = [
      "run",
      "--json",
      "--dry",
      "--case-file",
      "case.json",
      "--host",
      host,
      "--model",
      "synthetic",
      "--effort",
      "low",
      ...(host === "codex" ? ["--codex-auth-file", "auth.json"] : []),
    ];
    const selected = await run(root, args, {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
    expect(selected.code, selected.stderr).toBe(0);
    const evidence = parseRunEvidence(
      await readFile(
        defined(parseCliResult(selected.stdout).evidencePath),
        "utf8",
      ),
    );
    expect(evidence.configuration.redacted.hostConfiguration).toMatchObject({
      candidate: { "sevro.host.executable": binary },
    });
    const explicit = await run(
      root,
      [...args, `--${host}-bin`, "./bin/override"],
      { PATH: "/usr/bin:/bin" },
    );
    expect(explicit.code, explicit.stderr).toBe(0);
    const explicitEvidence = parseRunEvidence(
      await readFile(
        defined(parseCliResult(explicit.stdout).evidencePath),
        "utf8",
      ),
    );
    expect(
      explicitEvidence.configuration.redacted.hostConfiguration,
    ).toMatchObject({ candidate: { "sevro.host.executable": override } });
  },
);

test("relative CLI paths resolve from cwd through symlinks before runtime protection checks", async () => {
  const root = await project();
  await mkdir(join(root, "private"));
  await symlink("private", join(root, "alias"));
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["./alias"] },
    }),
  );
  const args = [
    "run",
    "--json",
    "--case-file",
    "./case.json",
    "--adapter-module",
    relative(root, adapter),
    "--project-root",
    ".",
    "--results-root",
    "./alias/results",
    "--runtime-config-file",
    "./runtime.json",
  ];
  const refused = await run(root, args);
  expect(refused.code, refused.stderr).toBe(64);
  expect(refused.stderr).toContain("runtime read root overlaps protected data");
  const success = await run(root, [
    ...args.slice(0, -4),
    "--project-digest",
    "a".repeat(64),
  ]);
  expect(success.code, success.stderr).toBe(0);
  expect(parseCliResult(success.stdout).task.verdict).toBe("passed");
});

test("built-in demo owns its inputs and reports an assessed verdict from an unrelated cwd", async () => {
  const root = await project();
  await writeFile(join(root, "sevro.json"), "invalid caller runtime policy");
  await symlink("missing-target", join(root, "unrelated-link"));
  const human = await run(root, ["demo"]);
  expect(human.code, human.stderr).toBe(0);
  expect(human.stdout).toContain(
    "execution=completed grading=completed task=passed",
  );
  const evidencePath = defined(
    human.stdout.split("\n").find((line) => line.startsWith("evidence=")),
  ).slice("evidence=".length);
  expect(evidencePath).toStartWith(join(root, ".sevro", "results"));
  const evidence = parseRunEvidence(await readFile(evidencePath, "utf8"));
  expect(evidence.result.task.verdict).toBe("passed");
  const json = await run(root, ["demo", "--json"]);
  expect(json.code, json.stderr).toBe(0);
  expect(parseCliResult(json.stdout).task.verdict).toBe("passed");
});

test.each([false, true])(
  "project-local results leave project identity stable while source changes alter it (Git=%s)",
  async (withGit) => {
    const root = await project();
    if (withGit) {
      await git(root, "init", "-q");
      await git(root, "add", "case.json");
      await git(
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
    }
    const args = [
      "run",
      "--json",
      "--case-file",
      "case.json",
      "--adapter-module",
      adapter,
    ];
    const first = await run(root, args);
    const second = await run(root, args);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const before = parseRunEvidence(
      await readFile(
        defined(parseCliResult(first.stdout).evidencePath),
        "utf8",
      ),
    );
    const repeated = parseRunEvidence(
      await readFile(
        defined(parseCliResult(second.stdout).evidencePath),
        "utf8",
      ),
    );
    expect(repeated.evaluationIdentity.dimensions.projectDigest).toBe(
      before.evaluationIdentity.dimensions.projectDigest,
    );
    expect(repeated.project.dirtyPatchDigest).toBe(
      before.project.dirtyPatchDigest,
    );
    await writeFile(
      join(root, withGit ? "case.json" : "source.txt"),
      withGit
        ? JSON.stringify({ ...baseline, prompt: "Return ready again." })
        : "meaningful new source\n",
    );
    const third = await run(root, args);
    expect(third.code, third.stderr).toBe(0);
    const changed = parseRunEvidence(
      await readFile(
        defined(parseCliResult(third.stdout).evidencePath),
        "utf8",
      ),
    );
    expect(changed.evaluationIdentity.dimensions.projectDigest).not.toBe(
      before.evaluationIdentity.dimensions.projectDigest,
    );
  },
);

test("effective settings are visible on stderr before the candidate starts without contaminating JSON", async () => {
  const root = await project();
  await writeFile(
    join(root, "preview-host.ts"),
    `export default { id: "example.preview", model: "deterministic", effort: "none", run() { process.stderr.write("candidate-start\\n"); return Promise.resolve({ finalMessage: "ready", complete: true }); } };\n`,
  );
  const result = await run(root, [
    "run",
    "--json",
    "--case-file",
    "case.json",
    "--adapter-module",
    "./preview-host.ts",
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect(parseCliResult(result.stdout).task.verdict).toBe("passed");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toContain("sevro: effective settings ");
  expect(result.stderr.indexOf("sevro: effective settings ")).toBeLessThan(
    result.stderr.indexOf("candidate-start"),
  );
  const preview = defined(
    result.stderr
      .split("\n")
      .find((line) => line.startsWith("sevro: effective settings ")),
  );
  expect(
    JSON.parse(preview.slice("sevro: effective settings ".length)) as unknown,
  ).toMatchObject({
    condition: "passive",
    trials: 1,
    threshold: 1,
    jobs: 3,
    projectRoot: root,
    configRoot: root,
    resultsRoot: join(root, ".sevro", "results"),
    runStateRoot: join(root, ".sevro", "results"),
    shellCheckDefaults: { expectedExitCode: 0, timeoutMs: 30000 },
  });
});

test.each(["codex", "claude"] as const)(
  "missing selected %s binary names PATH and its explicit override before execution",
  async (host) => {
    const root = await project();
    const result = await run(
      root,
      ["run", "--json", "--case-file", "case.json", "--host", host],
      { PATH: join(root, "missing-bin") },
    );
    expect(result.code).toBe(64);
    expect(parseCliResult(result.stdout)).toMatchObject({
      task: { verdict: "not_assessed" },
      evidencePath: null,
    });
    expect(result.stderr).toContain("not found on PATH");
    expect(result.stderr).toContain(`--${host}-bin`);
  },
);

test("demo rejects unsupported settings as a configuration failure without an assessment", async () => {
  const root = await project();
  const result = await run(root, ["demo", "--json", "--host", "codex"]);
  expect(result.code).toBe(64);
  expect(parseCliResult(result.stdout)).toMatchObject({
    task: { verdict: "not_assessed" },
    evidencePath: null,
  });
  expect(result.stderr).toContain("demo accepts only --json");
});

test("demo reports an unusable TMPDIR as one actionable runner failure result", async () => {
  const root = await project();
  const result = await run(root, ["demo", "--json"], {
    TMPDIR: join(root, "absent-temp"),
  });
  expect(result.code).toBe(70);
  expect(parseCliResult(result.stdout)).toMatchObject({
    exitCode: 70,
    task: { verdict: "not_assessed" },
    evidencePath: null,
  });
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toContain("TMPDIR");
  expect(result.stderr).toContain("writable directory");
});

test.each([
  { scenario: "pass", missingCase: false, expected: 70 },
  { scenario: "fail", missingCase: false, expected: 1 },
  { scenario: "pass", missingCase: true, expected: 64 },
])(
  "CLI finalization preserves one result and the earlier failure (%j)",
  async ({ scenario, missingCase, expected }) => {
    const root = await project();
    const args = [
      "run",
      "--json",
      "--case-file",
      missingCase ? "absent.json" : "case.json",
      "--adapter-module",
      adapter,
    ];
    const command = join(cli, "..", "cli", "command.ts");
    const script = `import { main } from ${JSON.stringify(command)}; await main(${JSON.stringify(args)}, async () => { throw new Error("synthetic temporary-project cleanup failure"); });`;
    const result = await run(
      root,
      [script],
      { SEVRO_TEST_SCENARIO: scenario },
      ["--eval"],
    );
    expect(result.code, result.stderr).toBe(expected);
    expect(parseCliResult(result.stdout).exitCode).toBe(expected);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain(
      "synthetic temporary-project cleanup failure",
    );
  },
);
