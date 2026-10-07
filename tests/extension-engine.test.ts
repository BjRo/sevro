import { expectUnknown } from "./fixtures/assertions";
import {
  arrayContaining,
  defined,
  objectContaining,
  parseRunEvidence,
} from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runEvaluation, type HostAdapter } from "../src/engine";
import { openExtensionSession } from "../src/extension-session";
import instrumentedHost from "./fixtures/instrumented-adapter";
import { extensionFixtureCommand } from "./fixtures/extension-command";
const roots: string[] = [];
const source = join(import.meta.dir, "fixtures", "extension.ts");
const digest = "a".repeat(64);
const extensionCommand = extensionFixtureCommand();
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function assertLifecycleArtifact(scenario: string, workspace: string) {
  if (
    [
      "lifecycle-artifact",
      "lifecycle-source-artifact",
      "lifecycle-git-excluded-artifact",
    ].includes(scenario)
  )
    expect(
      await readFile(
        join(
          workspace,
          scenario === "lifecycle-git-excluded-artifact"
            ? ".agents/skills/example/SKILL.md"
            : "generated/data.txt",
        ),
        "utf8",
      ),
    ).toBe("prepared data\n");
}
function lifecycleHost(
  scenario: string,
  resultsRoot: string,
  hostAction?: (workspace: string, resultsRoot: string) => Promise<void>,
): HostAdapter {
  return {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run({ workspace }) {
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
        "fixture\n",
      );
      await assertLifecycleArtifact(scenario, workspace);
      await hostAction?.(workspace, resultsRoot);
      return {
        finalMessage: "ready",
        complete: true,
        actualCondition: "passive",
        ...(scenario === "lifecycle-host-observation"
          ? {
              observations: [
                {
                  id: "darrow.activation",
                  completeness: "complete" as const,
                  data: { selected: "darrow.tdd" },
                },
              ],
            }
          : {}),
        ...(scenario === "lifecycle-host-artifact"
          ? {
              artifacts: [
                {
                  id: "example.host.trace",
                  bytes: Buffer.from("host trace\n"),
                },
              ],
            }
          : {}),
      };
    },
  };
}
function extensionHostCapabilities(host?: HostAdapter) {
  return [
    ...(host?.instrumentation ?? []).map((item) => item.id),
    ...(host?.hostCapabilities ?? []),
  ];
}
function lifecyclePolicy(scenario: string) {
  return scenario.startsWith("lifecycle-policy")
    ? { taskVerdictPolicy: "example.policy" }
    : {};
}
async function lifecycleSources(scenario: string, projectRoot: string) {
  if (scenario !== "lifecycle-source-artifact") return {};
  const sourcePath = join(projectRoot, "case-sources", "data.txt");
  await Bun.write(sourcePath, "prepared data\n");
  return {
    preparationSources: {
      root: join(projectRoot, "case-sources"),
      refs: { "input-data": pathToFileURL(sourcePath).href },
    },
  };
}
async function lifecycleCase(
  session: Awaited<ReturnType<typeof openExtensionSession>>,
  projectRoot: string,
) {
  const [resolvedCase] = await session.resolve(
    new URL(`file://${projectRoot}/`).href,
    {},
  );
  if (
    !resolvedCase ||
    (resolvedCase.fixture.kind !== "inline" &&
      resolvedCase.fixture.kind !== "generated")
  )
    throw new Error("fixture mismatch");
  const caseData = {
    id: resolvedCase.id,
    prompt: resolvedCase.prompt,
    followUpPrompt: resolvedCase.followUpPrompt,
    fixture:
      resolvedCase.fixture.kind === "generated"
        ? resolvedCase.fixture
        : { files: resolvedCase.fixture.files },
    checks: resolvedCase.checks,
    requiredEvidence: resolvedCase.requiredEvidence,
  };
  return { resolvedCase, caseData };
}
async function runWithExtension(
  scenario: string,
  hostAction?: (workspace: string, resultsRoot: string) => Promise<void>,
  replaceBuiltinGraders: string[] = [],
  hostOverride?: HostAdapter,
  condition: "passive" | "enforced" = "passive",
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-extension-engine-"));
  roots.push(projectRoot);
  const sources = await lifecycleSources(scenario, projectRoot);
  const session = await openExtensionSession({
    command: extensionCommand(source, scenario),
    sourceFiles: [source],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec", "sevro.fixture.setup"],
    hostCapabilities: extensionHostCapabilities(hostOverride),
    replaceBuiltinGraders,
    ...lifecyclePolicy(scenario),
  });
  const { resolvedCase, caseData } = await lifecycleCase(session, projectRoot);
  const syntheticHost = lifecycleHost(
    scenario,
    join(projectRoot, "results"),
    hostAction,
  );
  const host = hostOverride ?? syntheticHost;
  const outcome = await runEvaluation({
    projectRoot,
    resultsRoot: join(projectRoot, "results"),
    case: caseData,
    extension: { session, resolvedCase },
    ...sources,
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition,
    trialCount: 1,
    passThreshold: 1,
  });
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  return { outcome, evidence, session };
}
test("extension checks add to built-ins and retain negotiated provenance", async () => {
  const { outcome, evidence, session } = await runWithExtension("lifecycle");
  expect(outcome.result.exitCode).toBe(0);
  expectUnknown(
    defined(defined(outcome.result.cases[0]).trials[0]).checks.map(
      (check) => check.id,
    ),
  ).toEqual(["ready", "example.extension.ready"]);
  expectUnknown(
    defined(defined(defined(outcome.result.cases[0]).trials[0]).checks[1])
      .evidenceRefs,
  ).toEqual(["sevro.observation.final-message"]);
  expect(evidence.extension).toMatchObject({
    id: "example.extension",
    protocol: "sevro.extension.v1",
    sourceDigest: session.identity.sourceDigest,
  });
  expect(evidence.evaluationIdentity.dimensions.extensionDigest).toBe(
    session.identity.sourceDigest,
  );
  expectUnknown(defined(evidence.trials[0]).metrics).toEqual([
    { id: "example.extension.score", value: 1, unit: "ratio" },
  ]);
  expectUnknown(
    evidence.graders.active.map((grader: { id: string }) => grader.id),
  ).toEqual(["sevro.regex", "example.extension"]);
});
test("domain outcomes remain separate from the task verdict", async () => {
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-domain-outcome",
  );
  expect(outcome.result.task.verdict).toBe("passed");
  expectUnknown(
    defined(defined(outcome.result.cases[0]).trials[0]).domainOutcomes,
  ).toEqual(defined(evidence.trials[0]).domainOutcomes);
  expectUnknown(defined(evidence.trials[0]).domainOutcomes).toEqual([
    {
      id: "example.extension.activation",
      status: "failed",
      evidenceRefs: ["sevro.observation.final-message"],
      data: { primarySkill: "other-skill" },
    },
  ]);
  expectUnknown(
    defined(defined(outcome.result.cases[0]).trials[0]).checks.map(
      (check) => check.id,
    ),
  ).toEqual(["ready", "example.extension.ready"]);
  const invalid = await runWithExtension("lifecycle-domain-outcome-invalid");
  expect(invalid.outcome.result).toMatchObject({
    grading: { status: "error" },
    task: { verdict: "not_assessed" },
  });
});
test("explicit grader replacement removes only the selected built-in checks", async () => {
  const defaultRun = await runWithExtension("lifecycle-replace-regex");
  expect(defaultRun.outcome.result.task.verdict).toBe("failed");
  expectUnknown(
    defined(defined(defaultRun.outcome.result.cases[0]).trials[0]).checks.map(
      (check) => check.id,
    ),
  ).toEqual(["ready", "example.extension.ready"]);
  const selected = await runWithExtension(
    "lifecycle-replace-regex",
    undefined,
    ["sevro.regex"],
  );
  expect(selected.outcome.result.task.verdict).toBe("passed");
  expectUnknown(
    defined(defined(selected.outcome.result.cases[0]).trials[0]).checks.map(
      (check) => check.id,
    ),
  ).toEqual(["example.extension.ready"]);
  expect(selected.evidence.graders).toMatchObject({
    active: [{ id: "example.extension", source: "extension" }],
    replacedDefaults: ["sevro.regex"],
  });
  expectUnknown(
    defined(selected.evidence.extension).replacements.graders,
  ).toEqual(["sevro.regex"]);
  expect(selected.evidence.evaluationIdentity.digest).not.toBe(
    defaultRun.evidence.evaluationIdentity.digest,
  );
  expect(
    runWithExtension("lifecycle-replace-regex", undefined, ["sevro.json"]),
  ).rejects.toThrow(/unknown or duplicate built-in grader replacement/);
  expect(
    runWithExtension("lifecycle-replace-no-extension", undefined, [
      "sevro.regex",
    ]),
  ).rejects.toThrow(/requires an extension check/);
  const shell = await runWithExtension("lifecycle-replace-shell", undefined, [
    "sevro.shell",
  ]);
  expect(shell.outcome.result.task.verdict).toBe("passed");
  expect(defined(shell.evidence.trials[0]).observations).not.toEqual(
    arrayContaining([objectContaining({ source: "sevro.shell" })]),
  );
  const semantic = await runWithExtension(
    "lifecycle-replace-semantic",
    undefined,
    ["sevro.semantic"],
  );
  expect(semantic.outcome.result.task.verdict).toBe("passed");
  expectUnknown(
    semantic.evidence.routes.map((route: { role: string }) => route.role),
  ).toEqual(["candidate"]);
});
test("selected task policy may replace a failed check verdict and retains its decision", async () => {
  const { outcome, evidence } = await runWithExtension("lifecycle-policy");
  expect(outcome.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "passed" },
    exitCode: 0,
  });
  expect(
    defined(defined(defined(outcome.result.cases[0]).trials[0]).checks[0])
      .status,
  ).toBe("failed");
  expect(defined(evidence.extension).replacements.taskVerdictPolicy).toBe(
    "example.policy",
  );
  expectUnknown(defined(evidence.trials[0]).taskVerdictPolicy).toEqual({
    id: "example.policy",
    recommendation: "passed",
  });
  const missing = await runWithExtension("lifecycle-policy-missing");
  expect(missing.outcome.result).toMatchObject({
    grading: { status: "error" },
    task: { verdict: "not_assessed" },
    exitCode: 3,
  });
  const unavailable = await runWithExtension("lifecycle-policy-unavailable");
  expect(unavailable.outcome.result).toMatchObject({
    grading: { status: "unavailable" },
    task: { verdict: "not_assessed" },
    exitCode: 4,
  });
  const failedHost = await runWithExtension("lifecycle-policy", () => {
    return Promise.reject(new Error("host failed"));
  });
  expect(failedHost.outcome.result).toMatchObject({
    execution: { status: "failed" },
    task: { verdict: "not_assessed" },
    exitCode: 2,
  });
});
test("extension grading receives complete host observations", async () => {
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-host-observation",
  );
  expect(outcome.result.task.verdict).toBe("passed");
  expectUnknown(
    defined(defined(defined(outcome.result.cases[0]).trials[0]).checks[1])
      .evidenceRefs,
  ).toEqual(["darrow.activation"]);
  expect(defined(defined(evidence.trials[0]).observations[1])).toMatchObject({
    id: "darrow.activation",
    completeness: "complete",
    data: { selected: "darrow.tdd" },
  });
});
test("extension grading receives retained host artifacts", async () => {
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-host-artifact",
  );
  expect(outcome.result.task.verdict).toBe("passed");
  expectUnknown(
    defined(defined(defined(outcome.result.cases[0]).trials[0]).checks[1])
      .evidenceRefs,
  ).toEqual(["example.host.trace"]);
  const artifact = defined(evidence.trials[0]).artifactRefs.find(
    (item: { id: string }) => item.id === "example.host.trace",
  );
  expect(artifact).toBeDefined();
  expect(await readFile(new URL(defined(artifact).path), "utf8")).toBe(
    "host trace\n",
  );
});
test("extension grading error cannot become a passing task", async () => {
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-empty-evidence",
  );
  expect(outcome.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "error" },
    task: { verdict: "not_assessed" },
    exitCode: 3,
  });
  expect(defined(evidence.diagnostic).code).toBe("sevro.grader.error");
  expect(
    defined(defined(defined(outcome.result.cases[0]).trials[0]).checks[0])
      .status,
  ).toBe("passed");
});
test("an omitted declared extension check leaves grading unavailable", async () => {
  const { outcome } = await runWithExtension("lifecycle-missing-check");
  expect(outcome.result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "unavailable" },
    task: { verdict: "not_assessed" },
    exitCode: 4,
  });
});
test("unsupported instrumentation stops before host execution", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-extension-prepare-"));
  roots.push(projectRoot);
  const session = await openExtensionSession({
    command: extensionCommand(source, "lifecycle-instrumentation"),
    sourceFiles: [source],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
  });
  const [resolvedCase] = await session.resolve(
    new URL(`file://${projectRoot}/`).href,
    {},
  );
  if (!resolvedCase || resolvedCase.fixture.kind !== "inline")
    throw new Error("fixture mismatch");
  let called = false;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      called = true;
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  expect(
    runEvaluation({
      projectRoot,
      resultsRoot: join(projectRoot, "results"),
      case: {
        id: resolvedCase.id,
        prompt: resolvedCase.prompt,
        fixture: { files: resolvedCase.fixture.files },
        checks: resolvedCase.checks,
        requiredEvidence: resolvedCase.requiredEvidence,
      },
      extension: { session, resolvedCase },
      host,
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    }),
  ).rejects.toThrow(/unsupported instrumentation/);
  expect(called).toBe(false);
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("negotiated instrumentation records host application and rejects condition drift", async () => {
  const supported = await runWithExtension(
    "lifecycle-instrumentation-supported",
    undefined,
    [],
    instrumentedHost,
    "enforced",
  );
  expect(supported.outcome.result.task.verdict).toBe("passed");
  expect(supported.evidence.condition).toMatchObject({
    requested: "enforced",
    actual: "enforced",
    requestedInstrumentation: [
      { id: "example.extension.guard", configuration: {} },
    ],
    appliedInstrumentation: [
      { id: "example.extension.guard", configuration: {} },
    ],
  });
  expectUnknown(
    defined(supported.evidence.trials[0]).condition.appliedInstrumentation,
  ).toEqual(supported.evidence.condition.requestedInstrumentation);
  expect(defined(supported.evidence.extension).capabilities).toContain(
    "example.extension.guard",
  );
  expect(
    runWithExtension(
      "lifecycle-instrumentation",
      undefined,
      [],
      instrumentedHost,
      "enforced",
    ),
  ).rejects.toThrow(/unsupported instrumentation/);
  const observational = await runWithExtension(
    "lifecycle-instrumentation-observational",
    undefined,
    [],
    instrumentedHost,
    "passive",
  );
  expect(observational.outcome.result.task.verdict).toBe("passed");
  expect(observational.evidence.condition).toMatchObject({
    requested: "passive",
    actual: "passive",
    appliedInstrumentation: [
      { id: "example.extension.trace", configuration: {} },
    ],
  });
  expect(
    runWithExtension(
      "lifecycle-instrumentation-supported",
      undefined,
      [],
      instrumentedHost,
      "passive",
    ),
  ).rejects.toThrow(/passive condition cannot apply/);
  const mismatch = await runWithExtension(
    "lifecycle-instrumentation-supported",
    undefined,
    [],
    {
      ...instrumentedHost,
      async run(request) {
        return {
          ...(await instrumentedHost.run(request)),
          appliedInstrumentation: [],
        };
      },
    },
    "enforced",
  );
  expect(mismatch.outcome.result).toMatchObject({
    execution: { status: "failed" },
    task: { verdict: "not_assessed" },
    exitCode: 2,
  });
  expect(defined(mismatch.evidence.diagnostic).code).toBe(
    "sevro.instrumentation.mismatch",
  );
  expectUnknown(mismatch.evidence.condition.appliedInstrumentation).toEqual([]);
  const conditionDrift = await runWithExtension(
    "lifecycle-instrumentation-supported",
    undefined,
    [],
    {
      ...instrumentedHost,
      async run(request) {
        return {
          ...(await instrumentedHost.run(request)),
          actualCondition: "passive",
        };
      },
    },
    "enforced",
  );
  expect(conditionDrift.outcome.result.exitCode).toBe(2);
  expect(defined(conditionDrift.evidence.diagnostic).code).toBe(
    "sevro.instrumentation.mismatch",
  );
});
test("prepared inline artifacts survive fixture cleanup with their digest", async () => {
  const { outcome, evidence } = await runWithExtension("lifecycle-artifact");
  expect(outcome.result.exitCode).toBe(0);
  const [artifact] = defined(evidence.trials[0]).artifactRefs;
  expect(defined(artifact).id).toBe("generated-file");
  expect(defined(artifact).sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await readFile(new URL(defined(artifact).path), "utf8")).toBe(
    "prepared data\n",
  );
});
test("negotiated fixture setup runs before artifacts and enters comparison identity", async () => {
  const seen: string[] = [];
  const host: HostAdapter = {
    id: "sevro.host.setup-test",
    model: "synthetic-v1",
    effort: "none",
    async run({ workspace }) {
      seen.push(await readFile(join(workspace, "setup.txt"), "utf8"));
      seen.push(await readFile(join(workspace, "generated/data.txt"), "utf8"));
      return { finalMessage: "ready", complete: true };
    },
  };
  const { outcome, evidence, session } = await runWithExtension(
    "lifecycle-setup",
    undefined,
    [],
    host,
  );
  expect(outcome.result.exitCode, JSON.stringify(evidence.diagnostic)).toBe(0);
  expect(defined(seen[0])).toMatch(/\/cases\n$/);
  expect(defined(seen[1])).toBe("prepared data\n");
  expect(session.identity.capabilities).toContain("sevro.fixture.setup");
  expect(evidence.configuration.redacted.fixtureSetupDigest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(evidence.evaluationIdentity.dimensions.fixtureDigest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(defined(defined(evidence.trials[0]).artifactRefs[0]).id).toBe(
    "generated-file",
  );
});
test("fixture setup cannot redirect a preparation artifact outside the trial", async () => {
  const before = roots.length;
  expect(runWithExtension("lifecycle-setup-link")).rejects.toThrow(
    /preparation artifact traverses a non-directory/,
  );
  const projectRoot = defined(roots[before]);
  expectUnknown(await readdir(join(projectRoot, "outside"))).toEqual([]);
});
test("fixture setup refuses an extension without its negotiated capability", () => {
  expect(runWithExtension("lifecycle-setup-unnegotiated")).rejects.toThrow(
    "fixture setup capability was not negotiated",
  );
});
test("prepared skill files stay outside Git status without hiding candidate edits", async () => {
  const statuses: string[] = [];
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-git-excluded-artifact",
    async (workspace) => {
      const status = () =>
        new TextDecoder().decode(
          Bun.spawnSync(
            [
              "git",
              "-C",
              workspace,
              "status",
              "--porcelain",
              "--untracked-files=all",
            ],
            { stdout: "pipe" },
          ).stdout,
        );
      statuses.push(status());
      await writeFile(join(workspace, "README.md"), "candidate edit\n");
      statuses.push(status());
    },
  );
  expectUnknown(statuses).toEqual(["", " M README.md\n"]);
  expect(outcome.result.exitCode).toBe(0);
  expect(defined(defined(evidence.trials[0]).artifactRefs[0])).toMatchObject({
    id: "generated-file",
    gitExclude: true,
  });
  expect(evidence.evaluationIdentity.dimensions.fixtureDigest).toMatch(
    /^[a-f0-9]{64}$/,
  );
});
test("negotiated Codex marketplace reaches the host and binds fixture identity", async () => {
  let sawMarketplace = false;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    hostCapabilities: ["sevro.codex.plugin-marketplace"],
    async run(request) {
      expect(request.codexMarketplace).toMatchObject({
        artifactRoot: "marketplace",
        marketplaceName: "sevro-probe",
        pluginNames: ["probe"],
      });
      expect(request.codexMarketplace?.artifactPaths).toHaveLength(4);
      expect(
        await readFile(
          join(request.workspace, "marketplace/plugin/skills/probe/SKILL.md"),
          "utf8",
        ),
      ).toContain("Read this skill.");
      sawMarketplace = true;
      return {
        finalMessage: "ready",
        complete: true,
        actualCondition: "passive",
      };
    },
  };
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-codex-marketplace",
    undefined,
    [],
    host,
  );
  expect(outcome.result.exitCode).toBe(0);
  expect(sawMarketplace).toBe(true);
  expectUnknown(evidence.configuration.redacted.codexMarketplace).toEqual({
    artifactRoot: "marketplace",
    marketplaceName: "sevro-probe",
    pluginNames: ["probe"],
  });
  expect(defined(evidence.trials[0]).artifactRefs).toHaveLength(4);
});
test("Codex marketplace requires negotiation and a valid artifact root", () => {
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    hostCapabilities: ["sevro.codex.plugin-marketplace"],
    run() {
      return Promise.reject(new Error("host should not run"));
    },
  };
  expect(
    runWithExtension(
      "lifecycle-codex-marketplace-unnegotiated",
      undefined,
      [],
      host,
    ),
  ).rejects.toThrow(/capability was not negotiated/);
  expect(
    runWithExtension(
      "lifecycle-codex-marketplace-bad-root",
      undefined,
      [],
      host,
    ),
  ).rejects.toThrow(/invalid Codex marketplace declaration/);
});
test("negotiated Claude plugin directory reaches the host and binds fixture identity", async () => {
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    hostCapabilities: ["sevro.claude.plugin-dirs"],
    async run(request) {
      expectUnknown(request.claudePluginDirs).toEqual({
        artifactRoots: ["marketplace/plugin"],
        artifactPaths: [
          "marketplace/plugin/.claude-plugin/plugin.json",
          "marketplace/plugin/.codex-plugin/plugin.json",
          "marketplace/plugin/skills/probe/SKILL.md",
        ],
      });
      expect(
        await readFile(
          join(
            request.workspace,
            "marketplace/plugin/.claude-plugin/plugin.json",
          ),
          "utf8",
        ),
      ).toContain('"name":"probe"');
      return {
        finalMessage: "ready",
        complete: true,
        actualCondition: "passive",
      };
    },
  };
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-claude-plugin",
    undefined,
    [],
    host,
  );
  expect(outcome.result.exitCode).toBe(0);
  expectUnknown(evidence.configuration.redacted.claudePluginDirs).toEqual({
    artifactRoots: ["marketplace/plugin"],
  });
  expect(defined(evidence.trials[0]).artifactRefs).toHaveLength(4);
});
test("Claude plugin directory rejects unnegotiated or unsafe packages", () => {
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    hostCapabilities: ["sevro.claude.plugin-dirs"],
    run() {
      return Promise.reject(new Error("host should not run"));
    },
  };
  for (const scenario of [
    "lifecycle-claude-plugin-unnegotiated",
    "lifecycle-claude-plugin-bad-root",
    "lifecycle-claude-plugin-no-manifest",
    "lifecycle-claude-plugin-not-excluded",
  ]) {
    expect(runWithExtension(scenario, undefined, [], host)).rejects.toThrow(
      /Claude plugin directory/,
    );
  }
});
test("explicit Codex invocation renders once and reaches the selected host", async () => {
  let delivered = false;
  const host: HostAdapter = {
    id: "sevro.host.codex",
    model: "synthetic-v1",
    effort: "none",
    hostCapabilities: [
      "sevro.codex.plugin-marketplace",
      "sevro.codex.explicit-invocation",
    ],
    run(request) {
      expect(request.prompt).toBe("Use $probe:probe and return ready.");
      expectUnknown(request.explicitSkillInvocation).toEqual({
        pluginName: "probe",
        skillName: "probe",
        token: "$probe:probe",
      });
      delivered = true;
      return Promise.resolve({
        finalMessage: "ready",
        complete: true,
        actualCondition: "passive",
      });
    },
  };
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-codex-marketplace-explicit-invocation",
    undefined,
    [],
    host,
  );
  expect(outcome.result.exitCode).toBe(0);
  expect(delivered).toBe(true);
  expectUnknown(evidence.configuration.redacted.codexSkillInvocation).toEqual({
    pluginName: "probe",
    skillName: "probe",
  });
  expect(
    runWithExtension(
      "lifecycle-codex-marketplace-explicit-invocation-repeated",
      undefined,
      [],
      host,
    ),
  ).rejects.toThrow(/invalid Codex skill invocation declaration/);
  expect(
    runWithExtension(
      "lifecycle-codex-marketplace-explicit-invocation-unnegotiated",
      undefined,
      [],
      host,
    ),
  ).rejects.toThrow(/capability was not negotiated/);
});
test("explicit repository invocation preserves scope and retained identity", async () => {
  const host: HostAdapter = {
    id: "sevro.host.codex",
    model: "synthetic-v1",
    effort: "none",
    hostCapabilities: ["sevro.codex.repository-invocation"],
    async run(request) {
      expect(request.prompt).toBe("Use $probe and return ready.");
      expect(request.codexMarketplace).toBeUndefined();
      expectUnknown(request.explicitSkillInvocation).toEqual({
        scope: "repository",
        skillName: "probe",
        token: "$probe",
      });
      expect(
        await Bun.file(
          request.workspace + "/.agents/skills/probe/SKILL.md",
        ).exists(),
      ).toBeTrue();
      return {
        finalMessage: "ready",
        complete: true,
        actualCondition: "passive",
      };
    },
  };
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-codex-repository-explicit-invocation",
    undefined,
    [],
    host,
  );
  expect(outcome.result.exitCode).toBe(0);
  expectUnknown(
    evidence.configuration.redacted.codexRepositorySkillInvocation,
  ).toEqual({ skillName: "probe" });
  expect(evidence.configuration.redacted.codexSkillInvocation).toBeUndefined();
  for (const suffix of ["repeated", "missing-mount", "not-excluded"])
    expect(
      runWithExtension(
        `lifecycle-codex-repository-explicit-invocation-${suffix}`,
        undefined,
        [],
        host,
      ),
    ).rejects.toThrow(/invalid Codex repository skill invocation declaration/);
  expect(
    runWithExtension(
      "lifecycle-codex-repository-explicit-invocation-unnegotiated",
      undefined,
      [],
      host,
    ),
  ).rejects.toThrow(/capability was not negotiated/);
  expect(
    runWithExtension(
      "lifecycle-codex-repository-explicit-invocation",
      undefined,
      [],
      { ...host, hostCapabilities: [] },
    ),
  ).rejects.toThrow(/capability was not negotiated/);
  expect(
    runWithExtension(
      "lifecycle-codex-repository-explicit-invocation-conflicting",
      undefined,
      [],
      host,
    ),
  ).rejects.toThrow(/only one explicit skill invocation/);
});
test("explicit Codex invocation can occur in the continuation turn", async () => {
  const host: HostAdapter = {
    id: "sevro.host.codex",
    model: "synthetic-v1",
    effort: "none",
    hostCapabilities: [
      "sevro.host.continuation",
      "sevro.codex.plugin-marketplace",
      "sevro.codex.explicit-invocation",
    ],
    run(request) {
      expect(request.prompt).toBe("Wait for the next request.");
      expect(request.followUpPrompt).toBe("Use $probe:probe and return ready.");
      return Promise.resolve({
        finalMessage: "ready",
        complete: true,
        actualCondition: "passive",
      });
    },
  };
  const { outcome } = await runWithExtension(
    "lifecycle-codex-marketplace-explicit-invocation-later",
    undefined,
    [],
    host,
  );
  expect(outcome.result.exitCode).toBe(0);
});
test("explicit Claude repository invocation renders a native project command", async () => {
  const host: HostAdapter = {
    id: "sevro.host.claude",
    model: "synthetic-v1",
    effort: "none",
    hostCapabilities: ["sevro.claude.repository-invocation"],
    async run(request) {
      expect(request.prompt).toBe("/probe Return ready.");
      expect(request.claudePluginDirs).toBeUndefined();
      expectUnknown(request.explicitSkillInvocation).toEqual({
        scope: "repository",
        skillName: "probe",
        token: "/probe",
      });
      expect(
        await Bun.file(
          request.workspace + "/.claude/skills/probe/SKILL.md",
        ).exists(),
      ).toBe(true);
      return { finalMessage: "ready", complete: true };
    },
  };
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-claude-repository-explicit-invocation",
    undefined,
    [],
    host,
  );
  expect(outcome.result.exitCode).toBe(0);
  expectUnknown(
    evidence.configuration.redacted.claudeRepositorySkillInvocation,
  ).toEqual({ skillName: "probe" });
  for (const suffix of [
    "repeated",
    "missing-mount",
    "not-excluded",
    "nonleading",
  ])
    expect(
      runWithExtension(
        `lifecycle-claude-repository-explicit-invocation-${suffix}`,
        undefined,
        [],
        host,
      ),
    ).rejects.toThrow(/invalid Claude repository skill invocation declaration/);
  const unsupported: Array<[string, HostAdapter]> = [
    ["lifecycle-claude-repository-explicit-invocation-unnegotiated", host],
    [
      "lifecycle-claude-repository-explicit-invocation",
      { ...host, hostCapabilities: [] },
    ],
  ];
  for (const [scenario, candidate] of unsupported)
    expect(
      runWithExtension(scenario, undefined, [], candidate),
    ).rejects.toThrow(/capability was not negotiated/);
  expect(
    runWithExtension(
      "lifecycle-claude-repository-explicit-invocation-conflicting",
      undefined,
      [],
      host,
    ),
  ).rejects.toThrow(/only one explicit skill invocation/);
});
test("explicit Claude invocation renders a packaged slash token", async () => {
  const host: HostAdapter = {
    id: "sevro.host.claude",
    model: "synthetic-v1",
    effort: "none",
    hostCapabilities: [
      "sevro.claude.plugin-dirs",
      "sevro.claude.explicit-invocation",
    ],
    run(request) {
      expect(request.prompt).toBe("Use /probe:probe and return ready.");
      expectUnknown(request.explicitSkillInvocation).toEqual({
        pluginName: "probe",
        skillName: "probe",
        token: "/probe:probe",
      });
      return Promise.resolve({
        finalMessage: "ready",
        complete: true,
        actualCondition: "passive",
      });
    },
  };
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-claude-plugin-explicit-invocation",
    undefined,
    [],
    host,
  );
  expect(outcome.result.exitCode).toBe(0);
  expectUnknown(evidence.configuration.redacted.claudeSkillInvocation).toEqual({
    pluginName: "probe",
    skillName: "probe",
  });
  expect(
    runWithExtension(
      "lifecycle-claude-plugin-explicit-invocation-repeated",
      undefined,
      [],
      host,
    ),
  ).rejects.toThrow(/invalid Claude skill invocation declaration/);
  expect(
    runWithExtension(
      "lifecycle-claude-plugin-explicit-invocation-unnegotiated",
      undefined,
      [],
      host,
    ),
  ).rejects.toThrow(/capability was not negotiated/);
});
test("prepared executable artifact runs from the fixture and retains its mode", async () => {
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-executable-artifact",
    async (workspace) => {
      if (process.platform === "win32") return;
      const file = join(workspace, "generated/data.txt");
      const child = Bun.spawn([file], { stdout: "pipe", stderr: "pipe" });
      const [stdout, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stdout).toBe("ready\n");
    },
  );
  expect(outcome.result.exitCode).toBe(0);
  expect(defined(defined(evidence.trials[0]).artifactRefs[0])).toMatchObject({
    id: "generated-file",
    executable: true,
  });
  if (process.platform !== "win32") {
    const retained = new URL(
      defined(defined(evidence.trials[0]).artifactRefs[0]).path,
    );
    expect((await stat(retained)).mode & 0o100).toBe(0o100);
  }
});
test("Git-excluded preparation artifacts require a Git fixture", () => {
  expect(
    runWithExtension("lifecycle-git-excluded-inline-artifact"),
  ).rejects.toThrow(/require a Git fixture/);
});
test("declared source artifacts are retained and mounted with verified bytes", async () => {
  const { outcome, evidence } = await runWithExtension(
    "lifecycle-source-artifact",
  );
  expect(outcome.result.exitCode).toBe(0);
  const [artifact] = defined(evidence.trials[0]).artifactRefs;
  expect(await readFile(new URL(defined(artifact).path), "utf8")).toBe(
    "prepared data\n",
  );
});
test("a wrong preparation digest fails before host execution", async () => {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "sevro-extension-bad-artifact-"),
  );
  roots.push(projectRoot);
  const session = await openExtensionSession({
    command: extensionCommand(source, "lifecycle-bad-artifact"),
    sourceFiles: [source],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
  });
  const [resolvedCase] = await session.resolve(
    new URL(`file://${projectRoot}/`).href,
    {},
  );
  if (!resolvedCase || resolvedCase.fixture.kind !== "inline")
    throw new Error("fixture mismatch");
  let called = false;
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      called = true;
      return Promise.resolve({ finalMessage: "ready", complete: true });
    },
  };
  expect(
    runEvaluation({
      projectRoot,
      resultsRoot: join(projectRoot, "results"),
      case: {
        id: resolvedCase.id,
        prompt: resolvedCase.prompt,
        fixture: { files: resolvedCase.fixture.files },
        checks: resolvedCase.checks,
        requiredEvidence: resolvedCase.requiredEvidence,
      },
      extension: { session, resolvedCase },
      host,
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    }),
  ).rejects.toThrow(/preparation artifact digest/);
  expect(called).toBe(false);
});
test("a changed retained artifact cannot support a successful result", async () => {
  let workspace = "";
  try {
    expect(
      runWithExtension("lifecycle-artifact", async (fixture, resultsRoot) => {
        workspace = fixture;
        const runId = (await readdir(resultsRoot)).find((name) =>
          /^[a-f0-9]{8}-/.test(name),
        );
        await writeFile(
          join(resultsRoot, defined(runId), "prepared/generated/data.txt"),
          "tampered\n",
        );
      }),
    ).rejects.toThrow(/retained preparation artifact changed/);
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
});
