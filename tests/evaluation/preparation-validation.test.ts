import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openExtensionSession } from "../../src/extension-session";
import { wireCase, wireOptions } from "../fixtures/engine-session";
import {
  runEvaluation,
  EvaluationConfigurationError,
  type EvaluationOptions,
} from "../../src/engine";
import { defined } from "../fixtures/assertions";
import { requireSemantic } from "../fixtures/evaluation-fixtures";
import { createEvaluation } from "../fixtures/evaluation-fixtures";
import { createExtensionEvaluation } from "../fixtures/evaluation-fixtures";
import { createSetupEvaluation } from "../fixtures/evaluation-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const evaluation = createEvaluation(roots);

const extensionEvaluation = createExtensionEvaluation(evaluation);

const setupEvaluation = createSetupEvaluation(evaluation);

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
