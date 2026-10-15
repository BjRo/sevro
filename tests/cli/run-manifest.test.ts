import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapter,
  cli,
  digest,
  extensionSource,
  semanticAdapter,
} from "../fixtures/cli-fixtures";
import {
  defined,
  parseCliResult,
  parseRunEvidence,
} from "../fixtures/assertions";
import { extensionFixtureCommand } from "../fixtures/extension-command";
import baseline from "../../examples/basic/graded.json";

const roots: string[] = [];
const fixtureExtensionCommand = extensionFixtureCommand();
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function project() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-run-manifest-")),
  );
  roots.push(root);
  await mkdir(join(root, "settings"));
  await mkdir(join(root, "elsewhere"));
  await writeFile(join(root, "case.json"), JSON.stringify(baseline));
  return root;
}

async function save(root: string, settings: Record<string, unknown>) {
  const file = join(root, "settings", "evaluation.json");
  await writeFile(
    file,
    JSON.stringify({
      format: "sevro.run.v1",
      settings: {
        "case-file": "../case.json",
        "adapter-module": adapter,
        "project-root": "..",
        "runner-build-digest": digest,
        "project-digest": digest,
        ...settings,
      },
    }),
  );
  return file;
}

async function invokeOutput(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "run", ...args], {
    cwd: join(root, "elsewhere"),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SEVRO_TEST_SCENARIO: "pass" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function run(root: string, args: string[]) {
  const output = await invokeOutput(root, ["--json", ...args]);
  const result = parseCliResult(output.stdout);
  expect(output.stdout.trim().split("\n")).toHaveLength(1);
  return { ...output, result };
}

async function retained(output: Awaited<ReturnType<typeof run>>) {
  expect(output.code, output.stderr).toBe(0);
  return parseRunEvidence(
    await readFile(defined(output.result.evidencePath), "utf8"),
  );
}

test("saved settings replace defaults, repeat unchanged, and explicit flags replace saved settings", async () => {
  const root = await project();
  const manifest = await save(root, { trials: 2, jobs: 1, threshold: 0.5 });
  const args = ["--run-manifest-file", manifest];
  const first = await retained(await run(root, args));
  const repeated = await retained(await run(root, args));
  expect(first.result.task.verdict).toBe("passed");
  expect(first.result.cases[0]?.trials).toHaveLength(2);
  expect(first.configuration.redacted).toMatchObject({
    trialCount: 2,
    jobs: 1,
    passThreshold: 0.5,
  });
  expect(repeated.evaluationIdentity.digest).toBe(
    first.evaluationIdentity.digest,
  );
  const overridden = await retained(
    await run(root, [
      ...args,
      "--trials",
      "1",
      "--threshold",
      "1",
      "--jobs",
      "3",
    ]),
  );
  expect(overridden.result.cases[0]?.trials).toHaveLength(1);
  expect(overridden.configuration.redacted).toMatchObject({
    trialCount: 1,
    jobs: 3,
    passThreshold: 1,
  });
  expect(overridden.evaluationIdentity.digest).not.toBe(
    first.evaluationIdentity.digest,
  );
  expect(first.configuration.resolved).toMatchObject({
    format: "sevro.resolved-run-settings.v1",
    runManifestFile: manifest,
    trials: 2,
    threshold: 0.5,
    jobs: 1,
  });
});

test("manifest paths use its directory while CLI paths use cwd and storage relocation preserves identity", async () => {
  const root = await project();
  const manifest = await save(root, { "results-root": "../saved-results" });
  const saved = await retained(
    await run(root, ["--run-manifest-file", "../settings/evaluation.json"]),
  );
  expect(saved.configuration.resolved).toMatchObject({
    caseFile: join(root, "case.json"),
    projectRoot: root,
    resultsRoot: join(root, "saved-results"),
  });
  const explicit = await retained(
    await run(root, [
      "--case-file",
      "../case.json",
      "--adapter-module",
      adapter,
      "--project-root",
      "..",
      "--results-root",
      "./cli-results",
      "--runner-build-digest",
      digest,
      "--project-digest",
      digest,
    ]),
  );
  expect(explicit.configuration.resolved).toMatchObject({
    runManifestFile: null,
    resultsRoot: join(root, "elsewhere", "cli-results"),
  });
  expect(explicit.evaluationIdentity.digest).toBe(
    saved.evaluationIdentity.digest,
  );
  const relocated = await retained(
    await run(root, [
      "--run-manifest-file",
      manifest,
      "--results-root",
      "./other-results",
    ]),
  );
  expect(relocated.evaluationIdentity.digest).toBe(
    saved.evaluationIdentity.digest,
  );
});

test("a manifest directory alias resolves saved paths from its canonical target", async () => {
  const root = await project();
  await save(root, {});
  await mkdir(join(root, "elsewhere", "nested"));
  await symlink(
    join(root, "settings"),
    join(root, "elsewhere", "nested", "alias"),
  );
  const evidence = await retained(
    await run(root, ["--run-manifest-file", "nested/alias/evaluation.json"]),
  );
  expect(evidence.configuration.resolved).toMatchObject({
    caseFile: join(root, "case.json"),
    projectRoot: root,
    runManifestFile: join(root, "settings", "evaluation.json"),
  });
});

test("negative boolean flags override saved true without leaving an unassessed dry run", async () => {
  const root = await project();
  const manifest = await save(root, { dry: true, "shell-isolation": true });
  const dry = await retained(
    await run(root, ["--run-manifest-file", manifest]),
  );
  expect(dry.result.task.verdict).toBe("not_assessed");
  const executed = await retained(
    await run(root, [
      "--run-manifest-file",
      manifest,
      "--no-dry",
      "--no-shell-isolation",
    ]),
  );
  expect(executed.result.task.verdict).toBe("passed");
  expect(executed.configuration.resolved).toMatchObject({
    dry: false,
    shellIsolation: false,
  });
});

test("saved empty optional lists select no entries for an ordinary case", async () => {
  const root = await project();
  const manifest = await save(root, {
    "extension-source-file": [],
    "replace-builtin-grader": [],
    "protected-root": [],
    "advisory-exclude": [],
  });
  const evidence = await retained(
    await run(root, ["--run-manifest-file", manifest]),
  );
  expect(evidence.result.task.verdict).toBe("passed");
  expect(evidence.configuration.resolved).toMatchObject({
    extensionSourceFileCount: 0,
    replaceBuiltinGraders: [],
    protectedRoots: [],
    advisoryExcludedPaths: [],
  });
});

async function nativeSettings(root: string, semantic = false) {
  const binary = join(root, "native");
  await writeFile(binary, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  await writeFile(join(root, "auth.json"), "private-auth-sentinel");
  await writeFile(
    join(root, "case.json"),
    JSON.stringify({
      ...baseline,
      fixture: {
        kind: "generated",
        commits: [
          {
            message: "Fixture baseline",
            files: {
              "README.md": "fixture\n",
              "app.ts": "export const value = 1;\n",
            },
          },
        ],
        files: { "app.ts": "export const value = 2;\n" },
      },
      ...(semantic
        ? {
            checks: [
              {
                id: "semantic-ready",
                grader: "sevro.semantic",
                configuration: {
                  proposition: "The response promises readiness.",
                },
              },
            ],
          }
        : {}),
    }),
  );
  return {
    "adapter-module": undefined,
    host: "codex",
    "codex-bin": binary,
    "codex-auth-file": "../auth.json",
    model: "candidate-model",
    effort: "low",
    dry: true,
    "semantic-host": "codex",
    "semantic-model": "judge-model",
    "semantic-effort": "high",
    "advisory-host": "codex",
    "advisory-model": "advice-model",
    "advisory-effort": "medium",
  };
}

test("saved native candidate and grading roles retain explicit choices and bind semantic overrides", async () => {
  const root = await project();
  const manifest = await save(root, await nativeSettings(root, true));
  const args = ["--run-manifest-file", manifest];
  const savedRun = await run(root, args);
  const saved = await retained(savedRun);
  expect(saved.routes).toEqual([
    {
      role: "candidate",
      host: "sevro.host.codex",
      model: "candidate-model",
      effort: "low",
    },
    {
      role: "semantic",
      host: "sevro.host.codex",
      model: "judge-model",
      effort: "high",
    },
    {
      role: "advisory",
      host: "sevro.host.codex",
      model: "advice-model",
      effort: "medium",
    },
  ]);
  expect(savedRun.stderr).toContain('"model":"judge-model","effort":"high"');
  expect(savedRun.stderr).not.toContain("private-auth-sentinel");
  expect(JSON.stringify(saved.configuration.resolved)).not.toContain(
    "auth.json",
  );
  expect(JSON.stringify(saved)).not.toContain("private-auth-sentinel");
  const changed = await retained(
    await run(root, [
      ...args,
      "--model",
      "candidate-v2",
      "--semantic-effort",
      "low",
      "--codex-timeout-ms",
      "120000",
    ]),
  );
  expect(changed.evaluationIdentity.dimensions.routeDigest).not.toBe(
    saved.evaluationIdentity.dimensions.routeDigest,
  );
  expect(changed.configuration.redacted.runSettings).toMatchObject({
    candidateTimeoutMs: 120000,
    semanticTimeoutMs: 120000,
  });
  expect(changed.evaluationIdentity.dimensions.configurationDigest).not.toBe(
    saved.evaluationIdentity.dimensions.configurationDigest,
  );
});

test("explicit routes replace saved alternatives and repeated lists replace instead of append", async () => {
  const root = await project();
  const manifest = await save(root, {
    ...(await nativeSettings(root)),
    "advisory-exclude": ["saved-a", "saved-b"],
  });
  const changed = await retained(
    await run(root, [
      "--run-manifest-file",
      manifest,
      "--adapter-module",
      adapter,
      "--semantic-adapter-module",
      semanticAdapter,
      "--advisory-adapter-module",
      join(import.meta.dir, "..", "fixtures", "advisory-adapter.ts"),
      "--advisory-exclude",
      "cli-only",
      "--no-dry",
    ]),
  );
  expect(changed.result.task.verdict).toBe("passed");
  expect(changed.configuration.resolved).toMatchObject({
    candidate: { host: "sevro.host.synthetic" },
    semantic: { host: "sevro.host.semantic-synthetic" },
    advisoryExcludedPaths: ["cli-only"],
  });
  expect(changed.configuration.redacted.advisoryExcludedPaths).toEqual([
    "cli-only",
  ]);
  expect(changed.trials[0]?.advisoryReview?.status).toBe("completed");
});

test.each([
  { args: ["--model", "other-candidate"], dimension: "routeDigest" },
  { args: ["--effort", "medium"], dimension: "routeDigest" },
  { args: ["--semantic-model", "other-judge"], dimension: "routeDigest" },
  { args: ["--semantic-effort", "low"], dimension: "routeDigest" },
  { args: ["--advisory-model", "other-advice"], dimension: "routeDigest" },
  { args: ["--advisory-effort", "low"], dimension: "routeDigest" },
  { args: ["--trials", "2"], dimension: "trialCount" },
  { args: ["--threshold", "0.5"], dimension: "passThreshold" },
  { args: ["--jobs", "1"], dimension: "configurationDigest" },
  { args: ["--codex-timeout-ms", "120000"], dimension: "configurationDigest" },
  { args: ["--shell-isolation"], dimension: "configurationDigest" },
  {
    args: ["--protected-root", "../private"],
    dimension: "configurationDigest",
  },
] as const)(
  "a saved assessment selection independently affects identity (%j)",
  async ({ args: override, dimension }) => {
    const root = await project();
    const manifest = await save(root, await nativeSettings(root, true));
    const args = ["--run-manifest-file", manifest];
    const saved = await retained(await run(root, args));
    const changed = await retained(await run(root, [...args, ...override]));
    expect(changed.evaluationIdentity.dimensions[dimension]).not.toBe(
      saved.evaluationIdentity.dimensions[dimension],
    );
  },
);

test("manifest native routes reproduce equivalent explicit selections", async () => {
  const root = await project();
  const manifest = await save(root, await nativeSettings(root, true));
  const saved = await retained(
    await run(root, ["--run-manifest-file", manifest]),
  );
  const explicit = await retained(
    await run(root, [
      "--case-file",
      "../case.json",
      "--project-root",
      "..",
      "--runner-build-digest",
      digest,
      "--project-digest",
      digest,
      "--dry",
      "--host",
      "codex",
      "--codex-bin",
      "../native",
      "--codex-auth-file",
      "../auth.json",
      "--model",
      "candidate-model",
      "--effort",
      "low",
      "--semantic-host",
      "codex",
      "--semantic-model",
      "judge-model",
      "--semantic-effort",
      "high",
      "--advisory-host",
      "codex",
      "--advisory-model",
      "advice-model",
      "--advisory-effort",
      "medium",
    ]),
  );
  expect(explicit.evaluationIdentity.digest).toBe(
    saved.evaluationIdentity.digest,
  );
});

test("selecting the same saved native host preserves its model and effort", async () => {
  const root = await project();
  const manifest = await save(root, await nativeSettings(root));
  const saved = await retained(
    await run(root, ["--run-manifest-file", manifest]),
  );
  const explicit = await retained(
    await run(root, ["--run-manifest-file", manifest, "--host", "codex"]),
  );
  expect(explicit.evaluationIdentity.digest).toBe(
    saved.evaluationIdentity.digest,
  );
});

test("native routes replace saved adapters independently and retain saved grading model choices", async () => {
  const root = await project();
  const native = await nativeSettings(root, true);
  const manifest = await save(root, {
    ...native,
    host: undefined,
    model: undefined,
    effort: undefined,
    "adapter-module": adapter,
    "semantic-host": undefined,
    "semantic-adapter-module": semanticAdapter,
    "advisory-host": undefined,
    "advisory-adapter-module": adapter,
  });
  const selected = await retained(
    await run(root, [
      "--run-manifest-file",
      manifest,
      "--host",
      "codex",
      "--model",
      "explicit-candidate",
      "--effort",
      "low",
      "--semantic-host",
      "codex",
      "--advisory-host",
      "codex",
    ]),
  );
  expect(selected.routes).toMatchObject([
    { role: "candidate", model: "explicit-candidate" },
    { role: "semantic", model: "judge-model", effort: "high" },
    { role: "advisory", model: "advice-model", effort: "medium" },
  ]);
});

test("explicit false removes saved native diagnostics and Claude project-settings authority", async () => {
  const root = await project();
  const native = await nativeSettings(root);
  const manifest = await save(root, {
    ...native,
    host: "claude",
    "claude-bin": native["codex-bin"],
    "claude-project-settings": true,
    "retain-host-diagnostics": true,
  });
  const args = ["--run-manifest-file", manifest];
  const saved = await retained(await run(root, args));
  const changed = await retained(
    await run(root, [
      ...args,
      "--no-claude-project-settings",
      "--no-retain-host-diagnostics",
    ]),
  );
  expect(saved.configuration.resolved).toMatchObject({
    retainHostDiagnostics: true,
    claudeProjectSettings: true,
  });
  expect(changed.configuration.resolved).toMatchObject({
    retainHostDiagnostics: false,
    claudeProjectSettings: false,
  });
  expect(changed.evaluationIdentity.dimensions.configurationDigest).not.toBe(
    saved.evaluationIdentity.dimensions.configurationDigest,
  );
});

test.each([
  "model",
  "effort",
  "semantic-model",
  "semantic-effort",
  "advisory-model",
  "advisory-effort",
])(
  "saved native routes require an explicit %s instead of inferring another role's choice",
  async (missing) => {
    const root = await project();
    const manifest = await save(root, {
      ...(await nativeSettings(root, true)),
      [missing]: undefined,
    });
    const failed = await run(root, ["--run-manifest-file", manifest]);
    expect(failed.code).toBe(64);
    expect(failed.stderr).toContain(`missing --${missing}`);
    expect(failed.result.task.verdict).toBe("not_assessed");
  },
);

test("switching native candidate host requires fresh model and effort while retaining grading selection", async () => {
  const root = await project();
  const settings = await nativeSettings(root);
  const manifest = await save(root, settings);
  const incomplete = await run(root, [
    "--run-manifest-file",
    manifest,
    "--host",
    "claude",
    "--claude-bin",
    "../native",
  ]);
  expect(incomplete.code).toBe(64);
  expect(incomplete.stderr).toContain("missing --model");
  const changed = await retained(
    await run(root, [
      "--run-manifest-file",
      manifest,
      "--host",
      "claude",
      "--claude-bin",
      "../native",
      "--model",
      "claude-model",
      "--effort",
      "high",
    ]),
  );
  expect(changed.configuration.resolved).toMatchObject({
    candidate: {
      host: "sevro.host.claude",
      model: "claude-model",
      effort: "high",
    },
    semantic: { model: "judge-model", effort: "high" },
  });
});

test("CLI source selection replaces saved extension settings and can select an extension from a saved JSON case", async () => {
  const root = await project();
  const command = join(root, "command.json");
  await writeFile(
    command,
    JSON.stringify(fixtureExtensionCommand(extensionSource, "lifecycle")),
  );
  const manifest = await save(root, {
    "case-file": undefined,
    "extension-command-file": "../command.json",
    "case-id": "extension-case",
    "extension-source-file": [extensionSource],
    "task-verdict-policy": "example.policy",
    "replace-builtin-grader": ["sevro.regex"],
  });
  const ordinary = await retained(
    await run(root, [
      "--run-manifest-file",
      manifest,
      "--case-file",
      "../case.json",
    ]),
  );
  expect(ordinary.extension).toBeNull();
  expect(ordinary.result.task.verdict).toBe("passed");
  const privateSource = join(root, "private-evaluator-input.ts");
  await writeFile(privateSource, "export const evaluatorInput = 1;\n");
  await save(root, { "extension-source-file": [privateSource] });
  const selected = await run(root, [
    "--run-manifest-file",
    manifest,
    "--extension-command-file",
    "../command.json",
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
  ]);
  const extension = await retained(selected);
  expect(extension.extension?.id).toBe("example.extension");
  expect(extension.result.task.verdict).toBe("passed");
  expect(extension.configuration.resolved).toMatchObject({
    extensionSourceFileCount: 1,
  });
  expect(selected.stderr).not.toContain(privateSource);
  expect(selected.stderr).not.toContain(extensionSource);
  expect(JSON.stringify(extension.configuration.resolved)).not.toContain(
    extensionSource,
  );
});

test("runtime configuration remains separate and runtime environment is omitted from resolved settings", async () => {
  const root = await project();
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { EXAMPLE_PUBLIC_LABEL: "declared-runtime-value" } },
    }),
  );
  const manifest = await save(root, {
    "runtime-config-file": "../runtime.json",
  });
  const successful = await run(root, ["--run-manifest-file", manifest]);
  const evidence = await retained(successful);
  expect(evidence.configuration.resolved).toMatchObject({
    runtimeConfigFile: join(root, "runtime.json"),
  });
  expect(JSON.stringify(evidence.configuration.resolved)).not.toContain(
    "declared-runtime-value",
  );
  expect(successful.stderr).not.toContain("declared-runtime-value");
  expect(
    JSON.stringify(evidence.configuration.redacted.runtimePolicy),
  ).toContain("declared-runtime-value");
});

test("a saved manifest outside the project stays protected from runtime read grants", async () => {
  const root = await project();
  await mkdir(join(root, "work"));
  await symlink("settings", join(root, "manifest-alias"));
  await writeFile(
    join(root, "work", "runtime.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      filesystem: { readOnlyRoots: ["../manifest-alias"] },
    }),
  );
  const manifest = await save(root, {
    ...(await nativeSettings(root)),
    "project-root": "../work",
    "runtime-config-file": "../work/runtime.json",
  });
  const failed = await run(root, ["--run-manifest-file", manifest]);
  expect(failed.code).toBe(64);
  expect(failed.result.task.verdict).toBe("not_assessed");
  expect(failed.stderr).toContain("runtime read root overlaps protected data");
});

test.each([
  [null, "$"],
  [[], "$"],
  [{ format: "sevro.run.v2", settings: {} }, "format"],
  [{ format: "sevro.run.v1" }, "settings"],
  [{ format: "sevro.run.v1", settings: {}, typo: 1 }, "typo"],
  [{ format: "sevro.run.v1", settings: { trials: "2" } }, "settings.trials"],
  [{ format: "sevro.run.v1", settings: { dry: "yes" } }, "settings.dry"],
  [{ format: "sevro.run.v1", settings: { host: 42 } }, "settings.host"],
  [{ format: "sevro.run.v1", settings: { model: " " } }, "settings.model"],
  [
    { format: "sevro.run.v1", settings: { "protected-root": "../private" } },
    "settings.protected-root",
  ],
  [
    { format: "sevro.run.v1", settings: { "extension-source-file": [""] } },
    "settings.extension-source-file",
  ],
  [{ format: "sevro.run.v1", settings: { json: true } }, "settings.json"],
  [
    {
      format: "sevro.run.v1",
      settings: { "run-manifest-file": "nested.json" },
    },
    "settings.run-manifest-file",
  ],
  [{ format: "sevro.run.v1", settings: { typo: true } }, "settings.typo"],
] as const)(
  "invalid manifest %j reports field %s as one unassessed JSON result",
  async (value, field) => {
    const root = await project();
    const file = join(root, "invalid.json");
    await writeFile(file, JSON.stringify(value));
    const failed = await run(root, ["--run-manifest-file", file]);
    expect(failed.code).toBe(64);
    expect(failed.result).toMatchObject({
      task: { verdict: "not_assessed" },
      evidencePath: null,
    });
    expect(failed.stderr).toContain(file);
    expect(failed.stderr).toContain(field);
  },
);

test.each(["missing", "syntax", "oversize", "symlink", "directory"])(
  "unusable %s manifest keeps JSON failure output and actionable file context",
  async (kind) => {
    const root = await project();
    const file = join(root, "invalid.json");
    if (kind === "syntax")
      await writeFile(file, "{ private-invalid-json-marker");
    if (kind === "oversize") await writeFile(file, " ".repeat(65537));
    if (kind === "symlink") await symlink("case.json", file);
    if (kind === "directory") await mkdir(file);
    const failed = await run(root, ["--run-manifest-file", file]);
    expect(failed.code).toBe(64);
    expect(failed.result.task.verdict).toBe("not_assessed");
    expect(failed.stderr).toContain("--run-manifest-file");
    expect(failed.stderr).toContain(file);
    expect(failed.stderr).not.toContain("private-invalid-json-marker");
  },
);

test("a valid manifest with a later missing input preserves the JSON error contract", async () => {
  const root = await project();
  const manifest = await save(root, { "case-file": "../missing-case.json" });
  const failed = await run(root, ["--run-manifest-file", manifest]);
  expect(failed.code).toBe(64);
  expect(failed.result.task.verdict).toBe("not_assessed");
  expect(failed.stderr).toContain("missing-case.json");
});

test.each([
  { args: ["--json", "--no-json"], json: false },
  { args: ["--no-json", "--json"], json: true },
])(
  "preparation failures honor the last explicit JSON boolean (%j)",
  async ({ args, json }) => {
    const root = await project();
    const failed = await invokeOutput(root, [
      ...args,
      "--run-manifest-file",
      "missing.json",
    ]);
    expect(failed.code).toBe(64);
    if (json)
      expect(parseCliResult(failed.stdout).task.verdict).toBe("not_assessed");
    else
      expect(failed.stdout).toStartWith(
        "execution=not_run grading=not_requested task=not_assessed\n",
      );
  },
);
