import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openExtensionSession } from "../src/extension-session";
import { prepareFixtureSetup } from "../src/fixture-setup";
import { wireCase, wireOptions } from "./fixtures/quality-engine-session";
import {
  runEvaluation,
  EvaluationConfigurationError,
  type EvaluationOptions,
  type HostResult,
} from "../src/engine";
import {
  defined,
  parseRecord,
  parseRunEvidence,
  string,
} from "./fixtures/assertions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function evaluation(result: HostResult): Promise<EvaluationOptions> {
  const root = await mkdtemp(join(tmpdir(), "sevro-engine-quality-"));
  roots.push(root);
  return {
    projectRoot: root,
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    case: {
      id: "ready",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "independent fixture\n" } },
      checks: [
        {
          id: "response",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    },
    host: {
      id: "example.host",
      model: "fixture-v1",
      effort: "none",
      run: () => Promise.resolve(result),
    },
  };
}

function observation(id: string) {
  return { id, completeness: "complete" as const, data: { ready: true } };
}

test("fixture setup validation preserves declared argv and environment placeholders without executing them", () => {
  const declaration = {
    command: [process.execPath, "-e", "return-ready"],
    environment: {
      DATA: "{{sevro.workspace}}/input",
      PROJECT: "{{sevro.project}}",
    },
  };
  expect(prepareFixtureSetup(declaration)).toEqual(declaration);
  expect(prepareFixtureSetup({ command: [process.execPath] })).toEqual({
    command: [process.execPath],
    environment: {},
  });
  expect(prepareFixtureSetup(undefined)).toBeNull();
});

const invalidDirectSetup = [
  {
    name: "null declaration",
    value: null,
    diagnostic: "invalid fixture setup",
  },
  { name: "array declaration", value: [], diagnostic: "invalid fixture setup" },
  {
    name: "scalar declaration",
    value: 42,
    diagnostic: "invalid fixture setup",
  },
  {
    name: "empty argv",
    value: { command: [] },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "nonstring argv item",
    value: { command: [process.execPath, 42] },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "more than sixteen argv items",
    value: {
      command: [
        process.execPath,
        ...Array.from({ length: 16 }, () => "argument"),
      ],
    },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "argv above 64 KiB",
    value: { command: [process.execPath, "x".repeat(64 * 1024)] },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "NUL in argv",
    value: { command: [process.execPath, "\0"] },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "array environment",
    value: { command: [process.execPath], environment: [] },
    diagnostic: "invalid fixture setup environment",
  },
  {
    name: "scalar environment",
    value: { command: [process.execPath], environment: "environment" },
    diagnostic: "invalid fixture setup environment",
  },
  {
    name: "undeclared top-level field",
    value: { command: [process.execPath], extra: true },
    diagnostic: "unsupported fixture setup field",
  },
  {
    name: "more than thirty-two environment entries",
    value: {
      command: [process.execPath],
      environment: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`VALUE_${index}`, "x"]),
      ),
    },
    diagnostic: "invalid fixture setup environment",
  },
  {
    name: "environment above 16 KiB",
    value: {
      command: [process.execPath],
      environment: { DATA: "x".repeat(16 * 1024) },
    },
    diagnostic: "invalid fixture setup environment",
  },
  {
    name: "NUL in environment",
    value: { command: [process.execPath], environment: { DATA: "\0" } },
    diagnostic: "invalid fixture setup environment",
  },
];

for (const invalid of invalidDirectSetup) {
  test(`fixture setup validation refuses ${invalid.name} at its unknown-input boundary`, () => {
    expect(() => prepareFixtureSetup(invalid.value)).toThrow(
      invalid.diagnostic,
    );
  });
}

test("retained host configuration digest stays coherent when an adapter updates its configuration during execution", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const configuration = { "example.setting": "before" };
  options.host.configuration = configuration;
  options.host.run = () => {
    configuration["example.setting"] = "after";
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  const { result } = await runEvaluation(options);
  expect(configuration["example.setting"]).toBe("after");
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(evidence.configuration.digest).toBe(
    evidence.evaluationIdentity.dimensions.configurationDigest,
  );
  expect(evidence.configuration).toMatchObject({
    redacted: {
      hostConfiguration: { candidate: { "example.setting": "before" } },
    },
  });
});

function requireSemantic(options: EvaluationOptions, result: HostResult): void {
  options.case.checks = [
    {
      id: "meaning",
      grader: "sevro.semantic",
      configuration: { proposition: "The response confirms readiness." },
    },
  ];
  options.semanticHost = {
    id: "example.semantic-host",
    model: "grader-v1",
    effort: "none",
    run: () => Promise.resolve(result),
  };
}

function advisoryResponse(): string {
  return JSON.stringify({
    verdict: "pass",
    overallScore: 5,
    dimensions: {
      correctness: 5,
      maintainability: 5,
      testQuality: 5,
      scopeDiscipline: 5,
    },
    strengths: ["clear"],
    weaknesses: [],
    summary: "A passing independent review.",
  });
}

async function extensionEvaluation(
  responses: Record<string, unknown> = {},
  engineCapabilities: string[] = [],
): Promise<EvaluationOptions> {
  const options = await evaluation({
    finalMessage: "ready",
    complete: true,
    observations: [observation("example.evidence")],
  });
  const sessionOptions = wireOptions(responses);
  sessionOptions.engineCapabilities = engineCapabilities;
  const session = await openExtensionSession(sessionOptions);
  const resolved = defined(
    (await session.resolve(pathToFileURL(options.projectRoot).href, {}))[0],
  );
  if (resolved.fixture.kind !== "inline")
    throw new Error("Expected inline wire fixture");
  options.case = { ...resolved, fixture: { files: resolved.fixture.files } };
  options.extension = { session, resolvedCase: resolved };
  return options;
}

async function setupEvaluation(
  command: string[],
  preparation: Record<string, unknown> = {},
): Promise<EvaluationOptions> {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const fixture = {
    kind: "generated" as const,
    commits: [
      { message: "Setup baseline", files: { "README.md": "baseline\n" } },
    ],
  };
  const sessionOptions = wireOptions({
    describe: {
      extension: { id: "example.extension", version: "1.0.0" },
      protocols: ["sevro.extension.v1"],
      requiredCapabilities: ["sevro.fixture.setup"],
      optionalCapabilities: [],
      graders: ["example.extension"],
      taskVerdictPolicies: [],
    },
    resolve: { cases: [{ ...wireCase, fixture }] },
    prepare: {
      artifacts: [],
      requestedInstrumentation: [],
      fixtureSetup: { command },
      extensionData: {},
      ...preparation,
    },
  });
  sessionOptions.engineCapabilities = ["sevro.fixture.setup"];
  const session = await openExtensionSession(sessionOptions);
  const resolvedCase = defined(
    (await session.resolve(pathToFileURL(options.projectRoot).href, {}))[0],
  );
  options.case = { ...resolvedCase, fixture };
  options.extension = { session, resolvedCase };
  return options;
}

async function cancelReadySetup(options: EvaluationOptions) {
  const abort = new AbortController();
  options.signal = abort.signal;
  const ready = Promise.withResolvers<undefined>();
  const observer = watch(options.projectRoot, (_event, name) => {
    if (name === "setup-ready.json") ready.resolve(undefined);
  });
  const timer = setTimeout(() => {
    ready.reject(new Error("Fixture setup did not publish readiness"));
  }, 5000);
  const pending = runEvaluation(options);
  try {
    await Promise.race([
      ready.promise,
      pending.then(() => {
        throw new Error("Evaluation finished before setup readiness");
      }),
    ]);
    const receipt = parseRecord(
      await readFile(join(options.projectRoot, "setup-ready.json"), "utf8"),
    );
    expect(receipt).toHaveProperty("phase", "setup-running");
    abort.abort("SIGINT");
    return await pending;
  } finally {
    abort.abort("SIGINT");
    observer.close();
    clearTimeout(timer);
    await pending.catch(() => undefined);
  }
}

test("active trusted fixture setup cancellation retains an interrupted unassessed run before candidate admission", async () => {
  const options = await setupEvaluation([process.execPath, "-e", ""]);
  const script = join(options.projectRoot, "setup.ts");
  await writeFile(
    script,
    `
    import { writeFileSync, renameSync } from "node:fs";
    import { join } from "node:path";
    const root = process.argv[2];
    writeFileSync(join(root, "setup-ready.tmp"), JSON.stringify({phase: "setup-running"}));
    renameSync(join(root, "setup-ready.tmp"), join(root, "setup-ready.json"));
    setInterval(() => {}, 1000);
  `,
  );
  const configured = await setupEvaluation([
    process.execPath,
    script,
    options.projectRoot,
  ]);
  let candidateCalls = 0;
  configured.host.run = () => {
    candidateCalls++;
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  configured.projectRoot = options.projectRoot;
  const { result } = await cancelReadySetup(configured);
  expect(candidateCalls).toBe(0);
  expect(result.execution.status).toBe("cancelled");
  expect(result.grading.status).toBe("not_requested");
  expect(result.task.verdict).toBe("not_assessed");
  expect(result.exitCode).toBe(130);
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(evidence.result.execution.status).toBe("cancelled");
});

test("fixture setup interruption retains a prior completed trial and one cancelled partial attempt", async () => {
  const base = await evaluation({ finalMessage: "ready", complete: true });
  const code = `
    const fs = require("node:fs"), path = require("node:path"), root = process.argv[1];
    const first = path.join(root, "first-setup-complete");
    if (fs.existsSync(first)) {
      fs.writeFileSync(path.join(root, "setup-ready.tmp"), JSON.stringify({phase: "setup-running"}));
      fs.renameSync(path.join(root, "setup-ready.tmp"), path.join(root, "setup-ready.json"));
      setInterval(() => {}, 1000);
    } else fs.writeFileSync(first, "prepared");
  `;
  const options = await setupEvaluation([
    process.execPath,
    "-e",
    code,
    base.projectRoot,
  ]);
  options.projectRoot = base.projectRoot;
  options.trialCount = 2;
  options.jobs = 1;
  let candidateCalls = 0;
  options.host.run = () => {
    candidateCalls++;
    return Promise.resolve({
      finalMessage: "ready",
      complete: true,
      observations: [observation("example.evidence")],
    });
  };
  const { result } = await cancelReadySetup(options);
  expect(result.exitCode).toBe(130);
  expect(candidateCalls).toBe(1);
  const trials = defined(result.cases[0]).trials;
  expect(
    trials.map((trial) => [trial.execution.status, trial.task.verdict]),
  ).toEqual([
    ["completed", "passed"],
    ["cancelled", "not_assessed"],
  ]);
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(evidence.trials).toHaveLength(2);
  expect(
    await readFile(
      new URL(defined(defined(evidence.trials[0]).rawResult.path)),
      "utf8",
    ),
  ).toBe("ready");
  expect(defined(evidence.trials[1]).candidateDurationMs).toBeNull();
  expect(defined(evidence.trials[1]).rawResult.path).toBeNull();
});

test("ordinary trusted fixture setup failure stays a failure before candidate admission", async () => {
  const receiptRoot = await mkdtemp(
    join(tmpdir(), "sevro-setup-failure-receipt-"),
  );
  roots.push(receiptRoot);
  const receiptPath = join(receiptRoot, "failure.json");
  const code = `require("node:fs").writeFileSync(process.argv[1], JSON.stringify({workspace: process.cwd()})); process.exit(7);`;
  const options = await setupEvaluation([
    process.execPath,
    "-e",
    code,
    receiptPath,
  ]);
  let candidateCalls = 0;
  options.host.run = () => {
    candidateCalls++;
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  const pending = runEvaluation(options);
  expect(pending).rejects.toThrow("fixture setup failed (7)");
  await pending.catch(() => undefined);
  const receipt = parseRecord(await readFile(receiptPath, "utf8"));
  const workspace = string(receipt.workspace);
  try {
    expect(candidateCalls).toBe(0);
    expect(options.signal).toBeUndefined();
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "baseline\n",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function refusePreparedEvaluation(
  options: EvaluationOptions,
  diagnostic: string,
  cause?: string,
): Promise<void> {
  let candidateCalls = 0;
  options.host.run = () => {
    candidateCalls++;
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  const pending = runEvaluation(options);
  expect(pending).rejects.toBeInstanceOf(EvaluationConfigurationError);
  expect(pending).rejects.toThrow(diagnostic);
  const failure: unknown = await pending.catch((error: unknown) => error);
  if (cause !== undefined)
    expect(failure).toHaveProperty("cause", new Error(cause));
  expect(candidateCalls).toBe(0);
  expect(existsSync(options.resultsRoot)).toBeFalse();
}

function setupResponses(fixtureSetup: Record<string, unknown>) {
  return {
    describe: {
      extension: { id: "example.extension", version: "1.0.0" },
      protocols: ["sevro.extension.v1"],
      requiredCapabilities: ["sevro.fixture.setup"],
      optionalCapabilities: [],
      graders: ["example.extension"],
      taskVerdictPolicies: [],
    },
    prepare: {
      artifacts: [],
      requestedInstrumentation: [],
      fixtureSetup,
      extensionData: {},
    },
  };
}

const refusedSetupConfigurations = [
  {
    name: "a relative setup executable",
    setup: { command: ["relative-tool"] },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "a reserved setup HOME",
    setup: {
      command: [process.execPath],
      environment: { HOME: "private-home" },
    },
    diagnostic: "invalid fixture setup environment",
  },
  {
    name: "an unknown setup environment placeholder",
    setup: {
      command: [process.execPath],
      environment: { VALUE: "{{unknown}}" },
    },
    diagnostic: "invalid fixture setup environment",
  },
  {
    name: "negotiated setup for an inline fixture",
    setup: { command: [process.execPath] },
    diagnostic: "fixture setup requires a Git fixture",
  },
];

for (const refused of refusedSetupConfigurations) {
  test(`preparation refuses ${refused.name} before candidate admission or run allocation`, async () => {
    const options = await extensionEvaluation(setupResponses(refused.setup), [
      "sevro.fixture.setup",
    ]);
    await refusePreparedEvaluation(options, refused.diagnostic);
  });
}

test("preparation refuses an incomplete advisory route before candidate admission or run allocation", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  options.case.fixture = {
    kind: "generated",
    commits: [{ message: "Baseline", files: { "README.md": "baseline\n" } }],
  };
  options.advisoryHost = { ...options.host, id: "example.advisory", model: "" };
  await refusePreparedEvaluation(
    options,
    "advisory host identity is incomplete",
  );
});

test("preparation refuses a check from an unadvertised extension grader before candidate admission or run allocation", async () => {
  const options = await extensionEvaluation({
    resolve: {
      cases: [
        {
          ...wireCase,
          checks: [
            { id: "other-check", grader: "example.other", configuration: {} },
          ],
        },
      ],
    },
  });
  await refusePreparedEvaluation(
    options,
    "case declares an unavailable extension grader",
  );
});

test("preparation refuses an undeclared skill invocation placeholder before candidate admission or run allocation", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  options.case.prompt = "Invoke {{sevro.skill_invocation}}.";
  await refusePreparedEvaluation(
    options,
    "skill invocation placeholder requires a declaration",
  );
});

function preparedArtifact(id: string, relativePath: string) {
  const bytes = Buffer.from("prepared data\n");
  return {
    id,
    relativePath,
    contentBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function packagePreparationEvaluation(
  preparation: Record<string, unknown>,
  prompt = "Return ready.",
): Promise<EvaluationOptions> {
  const capabilities = [
    "sevro.codex.plugin-marketplace",
    "sevro.codex.explicit-invocation",
    "sevro.claude.plugin-dirs",
    "sevro.claude.explicit-invocation",
  ];
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const fixture = {
    kind: "generated" as const,
    commits: [{ message: "Baseline", files: { "README.md": "baseline\n" } }],
  };
  const sessionOptions = wireOptions({
    describe: {
      extension: { id: "example.extension", version: "1.0.0" },
      protocols: ["sevro.extension.v1"],
      requiredCapabilities: capabilities,
      optionalCapabilities: [],
      graders: ["example.extension"],
      taskVerdictPolicies: [],
    },
    resolve: { cases: [{ ...wireCase, prompt, fixture }] },
    prepare: {
      artifacts: [],
      requestedInstrumentation: [],
      extensionData: {},
      ...preparation,
    },
  });
  sessionOptions.engineCapabilities = capabilities;
  sessionOptions.hostCapabilities = capabilities;
  options.host.hostCapabilities = capabilities;
  const session = await openExtensionSession(sessionOptions);
  const resolvedCase = defined(
    (await session.resolve(pathToFileURL(options.projectRoot).href, {}))[0],
  );
  options.case = { ...resolvedCase, fixture };
  options.extension = { session, resolvedCase };
  return options;
}

const refusedPackagePreparations = [
  {
    name: "duplicate Claude package roots",
    preparation: {
      claudePluginDirs: { artifactRoots: ["plugins/a", "plugins/a"] },
    },
    diagnostic: "invalid Claude plugin directory declaration",
    cause: "invalid plugin roots",
  },
  {
    name: "nested Claude package roots",
    preparation: {
      claudePluginDirs: { artifactRoots: ["plugins/a", "plugins/a/nested"] },
    },
    diagnostic: "invalid Claude plugin directory declaration",
    cause: "overlapping plugin roots",
  },
  {
    name: "an invalid marketplace name",
    preparation: {
      codexMarketplace: {
        artifactRoot: "package",
        marketplaceName: "Bad Name",
        pluginNames: ["probe"],
      },
    },
    diagnostic: "invalid Codex marketplace declaration",
    cause: "invalid marketplace or plugin name",
  },
  {
    name: "duplicate marketplace plugin names",
    preparation: {
      codexMarketplace: {
        artifactRoot: "package",
        marketplaceName: "local",
        pluginNames: ["probe", "probe"],
      },
    },
    diagnostic: "invalid Codex marketplace declaration",
    cause: "invalid marketplace or plugin name",
  },
];

for (const refusal of refusedPackagePreparations) {
  test(`package preparation refuses ${refusal.name} with contextual cause before candidate admission`, async () => {
    const options = await packagePreparationEvaluation(refusal.preparation);
    await refusePreparedEvaluation(options, refusal.diagnostic, refusal.cause);
  });
}

const refusedPluginInvocations = [
  {
    name: "Codex invocation without its marketplace",
    prompt: "Use {{sevro.skill_invocation}}.",
    preparation: {
      codexSkillInvocation: { pluginName: "probe", skillName: "probe" },
    },
    diagnostic: "invalid Codex skill invocation declaration",
  },
  {
    name: "Codex invocation naming an unselected plugin",
    prompt: "Use {{sevro.skill_invocation}}.",
    preparation: {
      codexMarketplace: {
        artifactRoot: "package",
        marketplaceName: "local",
        pluginNames: ["probe"],
      },
      artifacts: [
        {
          ...preparedArtifact(
            "example.manifest",
            "package/.claude-plugin/marketplace.json",
          ),
          gitExclude: true,
        },
      ],
      codexSkillInvocation: { pluginName: "other", skillName: "probe" },
    },
    diagnostic: "invalid Codex skill invocation declaration",
  },
  {
    name: "Claude invocation using a Codex placeholder",
    prompt: "Use {{sevro.codex.skill_invocation}}.",
    preparation: {
      claudePluginDirs: { artifactRoots: ["package"] },
      artifacts: [
        {
          ...preparedArtifact(
            "example.manifest",
            "package/.claude-plugin/plugin.json",
          ),
          gitExclude: true,
        },
      ],
      claudeSkillInvocation: { pluginName: "probe", skillName: "probe" },
    },
    diagnostic: "invalid Claude skill invocation declaration",
  },
  {
    name: "Claude invocation without the declared packaged skill",
    prompt: "Use {{sevro.skill_invocation}}.",
    preparation: {
      claudePluginDirs: { artifactRoots: ["package"] },
      artifacts: [
        {
          ...preparedArtifact(
            "example.manifest",
            "package/.claude-plugin/plugin.json",
          ),
          gitExclude: true,
        },
      ],
      claudeSkillInvocation: { pluginName: "probe", skillName: "missing" },
    },
    diagnostic: "invalid Claude skill invocation declaration",
  },
];

for (const refusal of refusedPluginInvocations) {
  test(`package preparation refuses ${refusal.name} before candidate admission`, async () => {
    const options = await packagePreparationEvaluation(
      refusal.preparation,
      refusal.prompt,
    );
    await refusePreparedEvaluation(options, refusal.diagnostic);
  });
}

test("ownership initialization failure removes separately allocated run and state directories before candidate admission", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const stateRoot = join(options.projectRoot, "state");
  await mkdir(stateRoot);
  await writeFile(join(stateRoot, "owners"), "preserved blocking file\n");
  options.runStateRoot = stateRoot;
  let candidateCalls = 0;
  options.host.run = () => {
    candidateCalls++;
    return Promise.resolve({ finalMessage: "ready", complete: true });
  };
  const pending = runEvaluation(options);
  expect(pending).rejects.toThrow();
  await pending.catch(() => undefined);
  expect(candidateCalls).toBe(0);
  expect(await readdir(options.resultsRoot)).toEqual([]);
  expect(await readdir(stateRoot)).toEqual(["locks", "owners"]);
  expect(await readFile(join(stateRoot, "owners"), "utf8")).toBe(
    "preserved blocking file\n",
  );
});

test("preparation refuses an artifact using the semantic grader evidence ID before candidate admission or run allocation", async () => {
  const options = await extensionEvaluation({
    resolve: {
      cases: [
        {
          ...wireCase,
          checks: [
            {
              id: "meaning",
              grader: "sevro.semantic",
              configuration: {
                proposition: "The response confirms readiness.",
              },
            },
          ],
        },
      ],
    },
    prepare: {
      artifacts: [preparedArtifact("sevro.semantic.verdicts", "data.txt")],
      requestedInstrumentation: [],
      extensionData: {},
    },
  });
  requireSemantic(options, { finalMessage: "ready", complete: true });
  await refusePreparedEvaluation(
    options,
    "preparation artifact uses a reserved semantic evidence ID",
  );
});

test("preparation refuses an artifact targeting Git metadata before candidate admission or run allocation", async () => {
  const options = await setupEvaluation([process.execPath], {
    artifacts: [preparedArtifact("example.metadata", ".git/config")],
  });
  await refusePreparedEvaluation(
    options,
    "preparation artifacts cannot modify repository metadata",
  );
});

for (const location of ["host configuration", "fixture contents"] as const) {
  test(`preparation refuses unpaired Unicode in ${location} with identity context before candidate admission`, async () => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    if (location === "host configuration")
      options.host.configuration = { label: "\udc00" };
    else options.case.fixture = { files: { "README.md": "\udc00" } };
    await refusePreparedEvaluation(
      options,
      "invalid evaluation identity inputs",
    );
  });
}

test("extension grading can assess complete host observations when the optional final message is absent", async () => {
  const options = await extensionEvaluation();
  options.host.run = () =>
    Promise.resolve({
      finalMessage: null,
      complete: true,
      observations: [observation("example.evidence")],
    });
  const { result } = await runEvaluation(options);
  expect(result.execution.status).toBe("completed");
  expect(result.grading.status).toBe("completed");
  expect(result.task.verdict).toBe("passed");
  expect(result.exitCode).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(defined(evidence.trials[0]).rawResult.path).toBeNull();
  expect(defined(evidence.trials[0]).observationCompleteness).toBe(
    "unavailable",
  );
});

test("extension grading retains a failed check without inventing detail or evidence", async () => {
  const options = await extensionEvaluation({
    evaluate: {
      checks: [
        {
          id: "example.extension.ready",
          status: "failed",
          detail: "",
          evidenceRefs: [],
        },
      ],
      metrics: [],
    },
  });
  const { result } = await runEvaluation(options);
  expect(result.execution.status).toBe("completed");
  expect(result.grading.status).toBe("completed");
  expect(result.task.verdict).toBe("failed");
  expect(result.exitCode).toBe(1);
  expect(defined(defined(result.cases[0]).trials[0]).checks).toEqual([
    {
      id: "example.extension.ready",
      grader: "example.extension",
      status: "failed",
      evidenceRefs: [],
    },
  ]);
});

async function semanticPairEvaluation(
  entries: unknown[],
): Promise<EvaluationOptions> {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  options.case.checks = [
    {
      id: "first",
      grader: "sevro.semantic",
      configuration: { proposition: "The first criterion is met." },
    },
    {
      id: "second",
      grader: "sevro.semantic",
      configuration: { proposition: "The second criterion is met." },
    },
  ];
  options.semanticHost = {
    id: "example.semantic",
    model: "fixture",
    effort: "none",
    run: () =>
      Promise.resolve({
        finalMessage: JSON.stringify({ checks: entries }),
        complete: true,
      }),
  };
  return options;
}

async function pairedExtensionEvaluation(
  entries: unknown[],
): Promise<EvaluationOptions> {
  return extensionEvaluation({
    resolve: {
      cases: [
        {
          ...wireCase,
          checks: [
            {
              id: "example.extension.first",
              grader: "example.extension",
              configuration: {},
            },
            {
              id: "example.extension.second",
              grader: "example.extension",
              configuration: {},
            },
          ],
        },
      ],
    },
    evaluate: { checks: entries, metrics: [] },
  });
}

test("semantic grading associates two reversed verdicts with their declared criteria", async () => {
  const entries = [
    { id: "second", verdict: "fail", reason: "Second criterion unmet" },
    { id: "first", verdict: "pass", reason: "First criterion met" },
  ];
  const options = await semanticPairEvaluation(entries);
  const { result } = await runEvaluation(options);
  expect(result.execution.status).toBe("completed");
  expect(result.grading.status).toBe("completed");
  expect(result.task.verdict).toBe("failed");
  expect(result.exitCode).toBe(1);
  expect(
    defined(defined(result.cases[0]).trials[0]).checks.map(
      ({ id, status, detail }) => ({ id, status, detail }),
    ),
  ).toEqual([
    { id: "first", status: "passed", detail: "First criterion met" },
    { id: "second", status: "failed", detail: "Second criterion unmet" },
  ]);
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (item) => item.id === "sevro.semantic.verdicts",
    ),
  );
  expect(parseRecord(await readFile(new URL(artifact.path), "utf8"))).toEqual({
    checks: entries,
  });
});

test("extension grading associates two reversed results with their declared criteria", async () => {
  const options = await pairedExtensionEvaluation([
    {
      id: "example.extension.second",
      status: "failed",
      detail: "Second criterion unmet",
      evidenceRefs: ["example.evidence"],
    },
    {
      id: "example.extension.first",
      status: "passed",
      detail: "First criterion met",
      evidenceRefs: ["example.evidence"],
    },
  ]);
  const { result } = await runEvaluation(options);
  expect(result.execution.status).toBe("completed");
  expect(result.grading.status).toBe("completed");
  expect(result.task.verdict).toBe("failed");
  expect(result.exitCode).toBe(1);
  expect(
    defined(defined(result.cases[0]).trials[0]).checks.map(
      ({ id, status, detail }) => ({ id, status, detail }),
    ),
  ).toEqual([
    {
      id: "example.extension.first",
      status: "passed",
      detail: "First criterion met",
    },
    {
      id: "example.extension.second",
      status: "failed",
      detail: "Second criterion unmet",
    },
  ]);
});

for (const id of ["unknown", "first"] as const) {
  test(`semantic grading refuses a valid prefix followed by ${id === "first" ? "a duplicate" : "an unknown"} ID without accepting the prefix`, async () => {
    const entries = [
      { id: "first", verdict: "pass", reason: "First criterion met" },
      { id, verdict: "fail", reason: "Later invalid identifier" },
    ];
    const options = await semanticPairEvaluation(entries);
    const { result } = await runEvaluation(options);
    expect(result.execution.status).toBe("completed");
    expect(result.grading.status).toBe("error");
    expect(result.task.verdict).toBe("not_assessed");
    expect(result.exitCode).toBe(3);
    expect(defined(defined(result.cases[0]).trials[0]).checks).toEqual([]);
    const evidence = parseRunEvidence(
      await readFile(result.evidencePath, "utf8"),
    );
    expect(evidence.diagnostic).toEqual({
      code: "sevro.grader.error",
      message: "semantic grading did not complete",
    });
    expect(
      defined(evidence.trials[0]).observations.filter(
        (item) =>
          item.source === "example.semantic" &&
          Object.hasOwn(item.data, "verdict"),
      ),
    ).toEqual([]);
    const artifact = defined(
      defined(evidence.trials[0]).artifactRefs.find(
        (item) => item.id === "sevro.semantic.verdicts",
      ),
    );
    expect(parseRecord(await readFile(new URL(artifact.path), "utf8"))).toEqual(
      { checks: entries },
    );
  });
}

for (const suffix of ["unknown", "first"] as const) {
  test(`extension grading refuses a valid prefix followed by ${suffix === "first" ? "a duplicate" : "an undeclared"} ID without accepting the prefix`, async () => {
    const options = await pairedExtensionEvaluation([
      {
        id: "example.extension.first",
        status: "passed",
        evidenceRefs: ["example.evidence"],
      },
      { id: `example.extension.${suffix}`, status: "failed", evidenceRefs: [] },
    ]);
    const { result } = await runEvaluation(options);
    expect(result.execution.status).toBe("completed");
    expect(result.grading.status).toBe("error");
    expect(result.task.verdict).toBe("not_assessed");
    expect(result.exitCode).toBe(3);
    expect(defined(defined(result.cases[0]).trials[0]).checks).toEqual([]);
    const evidence = parseRunEvidence(
      await readFile(result.evidencePath, "utf8"),
    );
    expect(evidence.diagnostic).toEqual({
      code: "sevro.grader.error",
      message: "extension grading did not complete",
    });
    expect(defined(evidence.trials[0]).domainOutcomes).toEqual([]);
  });
}

async function instrumentedEvaluation(): Promise<EvaluationOptions> {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const sessionOptions = wireOptions({
    describe: {
      extension: { id: "example.extension", version: "1.0.0" },
      protocols: ["sevro.extension.v1"],
      requiredCapabilities: [],
      optionalCapabilities: ["example.instrumentation"],
      graders: ["example.extension"],
      taskVerdictPolicies: [],
    },
    prepare: {
      artifacts: [],
      requestedInstrumentation: [
        { id: "example.instrumentation", configuration: { enabled: true } },
      ],
      extensionData: {},
    },
  });
  sessionOptions.hostCapabilities = ["example.instrumentation"];
  const session = await openExtensionSession(sessionOptions);
  const resolved = defined(
    (await session.resolve(pathToFileURL(options.projectRoot).href, {}))[0],
  );
  if (resolved.fixture.kind !== "inline")
    throw new Error("Expected inline instrumentation fixture");
  options.case = { ...resolved, fixture: { files: resolved.fixture.files } };
  options.extension = { session, resolvedCase: resolved };
  options.host.instrumentation = [
    { id: "example.instrumentation", executionChanging: false },
  ];
  return options;
}

test("refuses applied instrumentation changed by an adapter from the prepared request", async () => {
  const options = await instrumentedEvaluation();
  options.host.run = (request) => {
    const appliedInstrumentation = defined(request.instrumentation);
    defined(appliedInstrumentation[0]).configuration.enabled = false;
    return Promise.resolve({
      finalMessage: "ready",
      complete: true,
      actualCondition: "passive",
      appliedInstrumentation,
      observations: [observation("example.evidence")],
    });
  };
  const { result } = await runEvaluation(options);
  expect(result.execution.status).toBe("failed");
  expect(result.exitCode).toBe(2);
  expect(result.task.verdict).toBe("not_assessed");
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(evidence.condition.requestedInstrumentation).toEqual([
    { id: "example.instrumentation", configuration: { enabled: true } },
  ]);
});

test("refuses a selected case that diverges from the extension-resolved declaration", async () => {
  const options = await extensionEvaluation();
  expect((await runEvaluation(options)).result.task.verdict).toBe("passed");
  options.case = { ...options.case, prompt: "Different selected task." };
  expect(runEvaluation(options)).rejects.toThrow(
    "resolved extension case does not match the selected case",
  );
});

const preparationRefusals = [
  {
    name: "Git-excluded artifact for an inline fixture",
    prepared: {
      artifacts: [
        {
          id: "example.file",
          relativePath: "prepared.txt",
          contentBase64: Buffer.from("prepared").toString("base64"),
          sha256: createHash("sha256").update("prepared").digest("hex"),
          gitExclude: true,
        },
      ],
    },
    diagnostic: "Git-excluded preparation artifacts require a Git fixture",
  },
  {
    name: "artifact that collides with fixture content",
    prepared: {
      artifacts: [
        {
          id: "example.file",
          relativePath: "README.md",
          contentBase64: Buffer.from("prepared").toString("base64"),
          sha256: createHash("sha256").update("prepared").digest("hex"),
        },
      ],
    },
    diagnostic: "collide",
  },
];

for (const refusal of preparationRefusals) {
  test(`refuses ${refusal.name} before admitting a candidate`, async () => {
    const options = await extensionEvaluation({
      prepare: {
        requestedInstrumentation: [],
        extensionData: {},
        ...refusal.prepared,
      },
    });
    let calls = 0;
    options.host.run = () => {
      calls++;
      return Promise.resolve({ finalMessage: "ready", complete: true });
    };
    const pending = runEvaluation(options);
    expect(pending).rejects.toBeInstanceOf(EvaluationConfigurationError);
    expect(pending).rejects.toThrow(refusal.diagnostic);
    await pending.catch(() => undefined);
    expect(calls).toBe(0);
    expect(existsSync(options.resultsRoot)).toBe(false);
  });
}

test("retains an undeclared extension check as a grading error without assessing it", async () => {
  const options = await extensionEvaluation({
    evaluate: {
      checks: [
        {
          id: "example.extension.undeclared",
          status: "passed",
          evidenceRefs: ["example.evidence"],
        },
      ],
      metrics: [],
    },
  });
  const outcome = await runEvaluation(options);
  expect(outcome.result.execution.status).toBe("completed");
  expect(outcome.result.grading.status).toBe("error");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(outcome.result.exitCode).toBe(3);
  expect(existsSync(outcome.result.evidencePath)).toBe(true);
});

test("records a failed advisory host without accepting its passing assessment", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  options.case.fixture = {
    kind: "generated",
    commits: [{ message: "base", files: { "README.md": "base\n" } }],
  };
  const message = advisoryResponse();
  let workspace = "";
  options.advisoryHost = {
    id: "example.advisory",
    model: "review-v1",
    effort: "none",
    run(request) {
      workspace = request.workspace;
      return Promise.resolve({
        finalMessage: message,
        complete: true,
        executionFailed: true,
        artifacts: [
          { id: "example.trace", bytes: Buffer.from("failed review trace") },
        ],
      });
    },
  };
  const outcome = await runEvaluation(options);
  expect(outcome.result.task.verdict).toBe("passed");
  expect(outcome.result.exitCode).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  const review = defined(trial.advisoryReview);
  expect(review.status).toBe("failed");
  expect(review.assessment).toBeNull();
  expect(await readFile(new URL(defined(review.rawResult.path)), "utf8")).toBe(
    message,
  );
  const trace = defined(
    trial.artifactRefs.find(
      (item) => item.id === "sevro.advisory.example.trace",
    ),
  );
  expect(await readFile(new URL(trace.path), "utf8")).toBe(
    "failed review trace",
  );
  expect(workspace).not.toBe("");
  expect(existsSync(workspace)).toBe(false);
});

const invalidPlans: {
  name: string;
  change: (options: EvaluationOptions) => void;
  diagnostic: string;
}[] = [
  {
    name: "unreadable project root",
    change(options) {
      options.projectRoot = join(options.projectRoot, "missing");
    },
    diagnostic: "project root is unreadable",
  },
  {
    name: "unsupported host continuation",
    change(options) {
      options.case.followUpPrompt = "Continue the task.";
    },
    diagnostic: "selected host does not support continuation",
  },
  {
    name: "generated history above the declared commit limit",
    change(options) {
      options.case.fixture = {
        kind: "generated",
        commits: Array.from({ length: 129 }, (_, index) => ({
          message: `commit ${index}`,
          files: {},
        })),
      };
    },
    diagnostic: "generated fixture",
  },
  {
    name: "generated repository metadata write",
    change(options) {
      options.case.fixture = {
        kind: "generated",
        commits: [{ message: "unsafe", files: { ".git/config": "unsafe" } }],
      };
    },
    diagnostic: "generated fixture cannot write repository metadata",
  },
  {
    name: "undeclared repository source",
    change(options) {
      options.case.fixture = { sourceRef: "undeclared" };
    },
    diagnostic: "repository source",
  },
  {
    name: "semantic check without a grader route",
    change(options) {
      requireSemantic(options, { finalMessage: "unused", complete: true });
      delete options.semanticHost;
    },
    diagnostic: "semantic checks require an explicit semantic host",
  },
  {
    name: "incomplete semantic host identity",
    change(options) {
      requireSemantic(options, { finalMessage: "unused", complete: true });
      defined(options.semanticHost).effort = "";
    },
    diagnostic: "semantic host identity is incomplete",
  },
  {
    name: "advisory review on an inline fixture",
    change(options) {
      options.advisoryHost = options.host;
    },
    diagnostic: "advisory review requires a Git fixture",
  },
  {
    name: "advisory exclusions without a reviewer",
    change(options) {
      options.advisoryExcludedPaths = ["README.md"];
    },
    diagnostic: "advisory exclusions require an advisory host",
  },
  {
    name: "duplicate check identities",
    change(options) {
      options.case.checks.push({ ...defined(options.case.checks[0]) });
    },
    diagnostic: "case check IDs must be unique",
  },
  {
    name: "unavailable extension grader",
    change(options) {
      defined(options.case.checks[0]).grader = "example.grader";
    },
    diagnostic: "case declares an unavailable extension grader",
  },
  {
    name: "shell check without isolation roots",
    change(options) {
      options.case.checks = [
        { id: "shell", grader: "sevro.shell", configuration: { run: "true" } },
      ];
    },
    diagnostic: "shell checks require explicit protected source roots",
  },
  {
    name: "Git HEAD check on an inline fixture",
    change(options) {
      options.case.checks = [
        {
          id: "revision",
          grader: "sevro.git-head",
          configuration: { mode: "unchanged" },
        },
      ];
    },
    diagnostic: "Git HEAD checks require a Git fixture",
  },
  {
    name: "relative project root",
    change: (options) => {
      options.projectRoot = "relative";
    },
    diagnostic: "roots must be absolute",
  },
  {
    name: "relative results root",
    change: (options) => {
      options.resultsRoot = "relative";
    },
    diagnostic: "roots must be absolute",
  },
  {
    name: "relative run-state root",
    change: (options) => {
      options.runStateRoot = "relative";
    },
    diagnostic: "roots must be absolute",
  },
  {
    name: "empty case identity",
    change: (options) => {
      options.case.id = "";
    },
    diagnostic: "identities must be nonempty",
  },
  {
    name: "empty host identity",
    change: (options) => {
      options.host.model = "";
    },
    diagnostic: "identities must be nonempty",
  },
  {
    name: "blank continuation",
    change: (options) => {
      options.case.followUpPrompt = " \n";
    },
    diagnostic: "follow-up prompt must be nonempty",
  },
  {
    name: "zero trials",
    change: (options) => {
      options.trialCount = 0;
    },
    diagnostic: "trial count must be a positive integer",
  },
  {
    name: "fractional trials",
    change: (options) => {
      options.trialCount = 1.5;
    },
    diagnostic: "trial count must be a positive integer",
  },
  {
    name: "zero concurrency",
    change: (options) => {
      options.jobs = 0;
    },
    diagnostic: "jobs must be a positive integer",
  },
  {
    name: "nonfinite threshold",
    change: (options) => {
      options.passThreshold = Number.POSITIVE_INFINITY;
    },
    diagnostic: "pass threshold must be greater than zero and at most one",
  },
  {
    name: "zero threshold",
    change: (options) => {
      options.passThreshold = 0;
    },
    diagnostic: "pass threshold must be greater than zero and at most one",
  },
  {
    name: "threshold above one",
    change: (options) => {
      options.passThreshold = 1.1;
    },
    diagnostic: "pass threshold must be greater than zero and at most one",
  },
  {
    name: "duplicate required evidence",
    change: (options) => {
      options.case.requiredEvidence = ["example.trace", "example.trace"];
    },
    diagnostic: "invalid required evidence IDs",
  },
  {
    name: "invalid required evidence",
    change: (options) => {
      options.case.requiredEvidence = ["../outside"];
    },
    diagnostic: "invalid required evidence IDs",
  },
];

for (const invalid of invalidPlans) {
  test(`refuses ${invalid.name} before candidate execution or result creation`, async () => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    const resultsRoot = options.resultsRoot;
    let calls = 0;
    options.host.run = () => {
      calls++;
      return Promise.resolve({ finalMessage: "ready", complete: true });
    };
    invalid.change(options);
    const pending = runEvaluation(options);
    expect(pending).rejects.toBeInstanceOf(EvaluationConfigurationError);
    expect(pending).rejects.toThrow(invalid.diagnostic);
    await pending.catch(() => undefined);
    expect(calls).toBe(0);
    expect(existsSync(resultsRoot)).toBe(false);
  });
}

const invalidReceipts: { name: string; result: HostResult }[] = [
  {
    name: "oversized final message",
    result: { finalMessage: "x".repeat(8 * 1024 * 1024 + 1), complete: true },
  },
  {
    name: "non-JSON observation data",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [
        {
          id: "example.trace",
          completeness: "complete",
          data: { value: Number.POSITIVE_INFINITY },
        },
      ],
    },
  },
  {
    name: "observation data beyond the byte limit",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [
        {
          id: "example.trace",
          completeness: "complete",
          data: { value: "x".repeat(8 * 1024 * 1024 + 1) },
        },
      ],
    },
  },
  {
    name: "artifact beyond the byte limit",
    result: {
      finalMessage: "ready",
      complete: true,
      artifacts: [
        { id: "example.trace", bytes: new Uint8Array(8 * 1024 * 1024 + 1) },
      ],
    },
  },
  {
    name: "artifact colliding with a built-in observation",
    result: {
      finalMessage: "ready",
      complete: true,
      artifacts: [
        {
          id: "sevro.observation.final-message",
          bytes: Buffer.from("collision"),
        },
      ],
    },
  },
  {
    name: "invalid observation ID",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [observation("../outside")],
    },
  },
  {
    name: "reserved observation ID",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [observation("sevro.observation.custom")],
    },
  },
  {
    name: "duplicate observations",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [
        observation("example.trace"),
        observation("example.trace"),
      ],
    },
  },
  {
    name: "observation count beyond the limit",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: Array.from({ length: 129 }, (_, index) =>
        observation(`example.trace-${index}`),
      ),
    },
  },
  {
    name: "duplicate artifacts",
    result: {
      finalMessage: "ready",
      complete: true,
      artifacts: [
        { id: "example.trace", bytes: Buffer.from("first") },
        { id: "example.trace", bytes: Buffer.from("second") },
      ],
    },
  },
  {
    name: "artifact count beyond the limit",
    result: {
      finalMessage: "ready",
      complete: true,
      artifacts: Array.from({ length: 33 }, (_, index) => ({
        id: `example.trace-${index}`,
        bytes: Buffer.from("trace"),
      })),
    },
  },
];

for (const receipt of invalidReceipts) {
  test(`rejects ${receipt.name} without assessing the candidate`, async () => {
    const options = await evaluation(receipt.result);
    const outcome = await runEvaluation(options);
    expect(outcome.result.execution.status).toBe("failed");
    expect(outcome.result.task.verdict).toBe("not_assessed");
    expect(outcome.result.exitCode).toBe(2);
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    const trial = defined(evidence.trials[0]);
    expect(trial.rawResult.path).toBeNull();
    expect(trial.observationCompleteness).toBe("unavailable");
    expect(trial.artifactRefs).toEqual([]);
    expect(defined(outcome.result.cases[0]).trials).toHaveLength(1);
  });
}

test("retains a failed host's raw response and artifacts before fixture cleanup", async () => {
  const bytes = Buffer.from("private diagnostic trace\n");
  const options = await evaluation({
    finalMessage: "ready",
    complete: false,
    executionFailed: true,
    artifacts: [{ id: "example.trace", bytes }],
    observations: [observation("example.receipt")],
  });
  let workspace = "";
  const host = options.host;
  options.host = {
    ...host,
    run(request) {
      workspace = request.workspace;
      return host.run(request);
    },
  };
  const outcome = await runEvaluation(options);
  expect(outcome.result.execution.status).toBe("failed");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(defined(defined(outcome.result.cases[0]).trials[0]).checks).toEqual(
    [],
  );
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  expect(await readFile(new URL(defined(trial.rawResult.path)), "utf8")).toBe(
    "ready",
  );
  const artifact = defined(
    trial.artifactRefs.find((item) => item.id === "example.trace"),
  );
  expect(await readFile(new URL(artifact.path))).toEqual(bytes);
  expect(artifact.sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(
    trial.observations.find((item) => item.id === "example.receipt"),
  ).toMatchObject({ completeness: "complete", data: { ready: true } });
  expect(workspace).not.toBe("");
  expect(existsSync(workspace)).toBe(false);
});

for (const candidate of [
  { name: "absent", finalMessage: null, complete: true },
  { name: "partial", finalMessage: "ready", complete: false },
]) {
  test(`keeps semantic grading unavailable for a ${candidate.name} candidate without calling the grader`, async () => {
    const options = await evaluation(candidate);
    requireSemantic(options, { finalMessage: "unused", complete: true });
    let calls = 0;
    options.semanticHost = {
      ...defined(options.semanticHost),
      run() {
        calls++;
        return Promise.resolve({ finalMessage: "unused", complete: true });
      },
    };
    const outcome = await runEvaluation(options);
    expect(calls).toBe(0);
    expect(outcome.result.execution.status).toBe("completed");
    expect(outcome.result.grading.status).toBe("unavailable");
    expect(outcome.result.task.verdict).toBe("not_assessed");
    expect(outcome.result.exitCode).toBe(4);
    expect(
      defined(defined(outcome.result.cases[0]).trials[0]).checks,
    ).toMatchObject([
      { id: "meaning", status: "unavailable", evidenceRefs: [] },
    ]);
  });
}

test("refuses a failed semantic host even when its output contains a passing verdict", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const verdict =
    '{"checks":[{"id":"meaning","verdict":"pass","reason":"Ready is stated"}]}';
  requireSemantic(options, {
    finalMessage: verdict,
    complete: true,
    executionFailed: true,
    artifacts: [
      { id: "example.trace", bytes: Buffer.from("failed grader trace") },
    ],
  });
  const outcome = await runEvaluation(options);
  expect(outcome.result.execution.status).toBe("completed");
  expect(outcome.result.grading.status).toBe("error");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(outcome.result.exitCode).toBe(3);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  const raw = defined(
    trial.artifactRefs.find((item) => item.id === "sevro.semantic.verdicts"),
  );
  expect(await readFile(new URL(raw.path), "utf8")).toBe(verdict);
  const trace = defined(
    trial.artifactRefs.find(
      (item) => item.id === "sevro.semantic.example.trace",
    ),
  );
  expect(await readFile(new URL(trace.path), "utf8")).toBe(
    "failed grader trace",
  );
});

for (const grader of [
  { name: "malformed", finalMessage: "{broken", complete: true },
  { name: "incomplete", finalMessage: '{"verdicts":[]}', complete: false },
]) {
  test(`retains ${grader.name} semantic output as a grading error and cleans its workspace`, async () => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    requireSemantic(options, grader);
    let workspace = "";
    const host = defined(options.semanticHost);
    options.semanticHost = {
      ...host,
      run(request) {
        workspace = request.workspace;
        return host.run(request);
      },
    };
    const outcome = await runEvaluation(options);
    expect(outcome.result.execution.status).toBe("completed");
    expect(outcome.result.grading.status).toBe("error");
    expect(outcome.result.task.verdict).toBe("not_assessed");
    expect(outcome.result.exitCode).toBe(3);
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    const raw = defined(
      defined(evidence.trials[0]).artifactRefs.find(
        (item) => item.id === "sevro.semantic.verdicts",
      ),
    );
    expect(await readFile(new URL(raw.path), "utf8")).toBe(grader.finalMessage);
    expect(workspace).not.toBe("");
    expect(existsSync(workspace)).toBe(false);
  });
}

const semanticDocuments: {
  name: string;
  path: string;
  files: Record<string, string>;
}[] = [
  { name: "missing", path: "answer.md", files: {} },
  {
    name: "ambiguous",
    path: "*.md",
    files: { "first.md": "ready", "second.md": "ready" },
  },
  {
    name: "oversized",
    path: "answer.md",
    files: { "answer.md": "x".repeat(64 * 1024 + 1) },
  },
];
for (const artifact of semanticDocuments) {
  test(`refuses ${artifact.name} semantic documents without calling the grader`, async () => {
    const options = await evaluation({ finalMessage: "ready", complete: true });
    options.case.fixture = { files: artifact.files };
    requireSemantic(options, { finalMessage: "unused", complete: true });
    defined(options.case.checks[0]).configuration.artifactPath = artifact.path;
    let calls = 0;
    options.semanticHost = {
      ...defined(options.semanticHost),
      run() {
        calls++;
        return Promise.resolve({ finalMessage: "unused", complete: true });
      },
    };
    const outcome = await runEvaluation(options);
    expect(calls).toBe(0);
    expect(outcome.result.grading.status).toBe("error");
    expect(outcome.result.task.verdict).toBe("not_assessed");
    expect(outcome.result.exitCode).toBe(3);
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    const raw = defined(defined(evidence.trials[0]).rawResult.path);
    expect(await readFile(new URL(raw), "utf8")).toBe("ready");
  });
}

test("retains semantic-phase cancellation and interrupted ownership before further trial admission", async () => {
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const controller = new AbortController();
  options.signal = controller.signal;
  options.runStateRoot = join(options.projectRoot, "state");
  options.trialCount = 2;
  options.jobs = 1;
  requireSemantic(options, { finalMessage: "unused", complete: true });
  let calls = 0;
  let workspace = "";
  options.semanticHost = {
    ...defined(options.semanticHost),
    run(request) {
      calls++;
      workspace = request.workspace;
      expect(request.signal).toBe(controller.signal);
      controller.abort("SIGTERM");
      return Promise.reject(new Error("grader cooperatively cancelled"));
    },
  };
  const outcome = await runEvaluation(options);
  expect(calls).toBe(1);
  expect(outcome.result.execution.status).toBe("cancelled");
  expect(outcome.result.task.verdict).toBe("not_assessed");
  expect(outcome.result.exitCode).toBe(143);
  expect(defined(outcome.result.cases[0]).trials).toHaveLength(1);
  expect(existsSync(workspace)).toBe(false);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expect(
    await readFile(
      new URL(defined(defined(evidence.trials[0]).rawResult.path)),
      "utf8",
    ),
  ).toBe("ready");
  const active = parseRecord(
    await readFile(
      join(options.runStateRoot, "active", `${outcome.result.runId}.json`),
      "utf8",
    ),
  );
  expect(active.status).toBe("interrupted");
});
