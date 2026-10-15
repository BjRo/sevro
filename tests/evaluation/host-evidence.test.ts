import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { openExtensionSession } from "../../src/extension-session";
import { wireOptions } from "../fixtures/engine-session";
import {
  runEvaluation,
  type EvaluationOptions,
  type HostResult,
} from "../../src/engine";
import { defined, parseRunEvidence } from "../fixtures/assertions";
import { observation } from "../fixtures/evaluation-fixtures";
import { createEvaluation } from "../fixtures/evaluation-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const evaluation = createEvaluation(roots);

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

const invalidReceipts: { name: string; result: HostResult }[] = [
  // JavaScript adapters can return malformed entries despite the TypeScript interface.
  {
    name: "nonobject observation",
    result: {
      finalMessage: "ready",
      complete: true,
      observations: [null],
    } as unknown as HostResult,
  },
  {
    name: "nonobject artifact",
    result: {
      finalMessage: "ready",
      complete: true,
      artifacts: [null],
    } as unknown as HostResult,
  },
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
