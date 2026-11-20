import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExtensionSession } from "../../../src/extensions/index";
import {
  wireCase,
  wireEvaluationRequest,
  wireOptions,
} from "../../fixtures/engine-session";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

type SessionOptions = Parameters<typeof openExtensionSession>[0];

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const declaredSource = join(import.meta.dir, "../../fixtures/extension.ts");
const discovery = {
  extension: { id: "example.extension", version: "1.0.0" },
  protocols: ["sevro.extension.v1"],
  requiredCapabilities: [],
  optionalCapabilities: [],
  graders: [],
  taskVerdictPolicies: [],
};

function producer(source: string): string[] {
  return [
    process.execPath,
    "-e",
    `const request = JSON.parse(await Bun.stdin.text()); ${source}`,
  ];
}

function reply(fields: Record<string, unknown>): string {
  return `process.stdout.write(JSON.stringify({ protocol: request.protocol, id: request.id, method: request.method, ...${JSON.stringify(fields)} }));`;
}

/** Answer discovery validly and run `source` for every later method. */
function describing(source: string): string[] {
  return producer(
    `if (request.method === "describe") { ${reply({ result: discovery })} } else { ${source} }`,
  );
}

function sessionOptions(
  command: string[],
  overrides: Partial<SessionOptions> = {},
): SessionOptions {
  return {
    command,
    sourceFiles: [declaredSource],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: [],
    hostCapabilities: [],
    ...overrides,
  };
}

async function launchMarker() {
  const root = await temporaryFixture(
    join(tmpdir(), "sevro-extension-launch-"),
  );
  const marker = join(root, "launched");
  const write = `await Bun.write(${JSON.stringify(marker)}, request.method);`;
  return {
    launched: () => Bun.file(marker).exists(),
    any: producer(`${write} ${reply({ result: discovery })}`),
    afterDiscovery: describing(write),
  };
}

test("reports the extension error code while keeping its private message out of diagnostics", () => {
  const pending = openExtensionSession(
    sessionOptions(
      producer(
        reply({
          error: {
            code: "example.refusal",
            message: "private source contents",
          },
        }),
      ),
    ),
  );
  expect(pending).rejects.toThrow("extension reported example.refusal");
  expect(pending).rejects.not.toThrow("private source contents");
});

test("rejects non-UTF-8 process output with useful encoding context", () => {
  expect(
    openExtensionSession(
      sessionOptions(producer("process.stdout.write(new Uint8Array([255]));")),
    ),
  ).rejects.toThrow("extension did not return one UTF-8 JSON response");
});

test("rejects a schema-valid response for another method before accepting its error", async () => {
  const session = await openExtensionSession(
    sessionOptions(
      describing(
        `process.stdout.write(JSON.stringify({ protocol: request.protocol, id: request.id, method: "prepare", error: { code: "example.refusal", message: "private mismatch" } }));`,
      ),
    ),
  );
  const pending = session.resolve("file:///tmp/project", {});
  expect(pending).rejects.toThrow("extension response does not match request");
  expect(pending).rejects.not.toThrow("private mismatch");
  await pending.catch(() => undefined);
});

test("refuses discovery when the extension offers only an incompatible protocol", () => {
  expect(
    openExtensionSession(
      sessionOptions(
        producer(
          reply({
            result: { ...discovery, protocols: ["sevro.extension.v2"] },
          }),
        ),
      ),
    ),
  ).rejects.toThrow(/no compatible protocol/);
});

for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
  test(`refuses invalid timeout ${timeoutMs} before trying to launch the extension`, async () => {
    const marker = await launchMarker();
    const pending = openExtensionSession(
      sessionOptions(marker.any, { timeoutMs }),
    );
    expect(pending).rejects.toThrow(
      "extension timeout must be a positive integer",
    );
    await pending.catch(() => undefined);
    expect(await marker.launched()).toBe(false);
  });
}

test("refuses an empty command and an empty argument before process launch", async () => {
  expect(openExtensionSession(sessionOptions([]))).rejects.toThrow(
    "extension source files must be unique absolute paths",
  );
  const marker = await launchMarker();
  const pending = openExtensionSession(sessionOptions([...marker.any, ""]));
  expect(pending).rejects.toThrow(
    "extension command must be a nonempty argv array",
  );
  await pending.catch(() => undefined);
  expect(await marker.launched()).toBe(false);
});

test("refuses an already-cancelled request before process launch", async () => {
  const marker = await launchMarker();
  const controller = new AbortController();
  controller.abort();
  const pending = openExtensionSession(
    sessionOptions(marker.any, { signal: controller.signal }),
  );
  expect(pending).rejects.toThrow("extension request cancelled");
  await pending.catch(() => undefined);
  expect(await marker.launched()).toBe(false);
});

test("refuses an oversized request before launching its process", async () => {
  const marker = await launchMarker();
  const session = await openExtensionSession(
    sessionOptions(marker.afterDiscovery, {
      configuration: { value: "x".repeat(8 * 1024 * 1024) },
    }),
  );
  const pending = session.resolve("file:///tmp/project", {});
  expect(pending).rejects.toThrow("extension request exceeds 8 MiB");
  await pending.catch(() => undefined);
  expect(await marker.launched()).toBe(false);
});

test("reports a launch failure with transport context", async () => {
  const root = await temporaryFixture(
    join(tmpdir(), "sevro-extension-launch-"),
  );
  const notExecutable = join(root, "extension");
  await writeFile(notExecutable, "not an executable\n", { mode: 0o644 });
  expect(
    openExtensionSession(
      sessionOptions([notExecutable], { sourceFiles: [notExecutable] }),
    ),
  ).rejects.toThrow("could not start extension process");
});

test("drains diagnostic stderr beyond its retention bound while accepting one valid stdout response", async () => {
  const command = producer(
    `process.stderr.write("private diagnostic\\n".repeat(10000)); ${reply({
      error: { code: "example.refusal", message: "private extension detail" },
    })}`,
  );
  const pending = openExtensionSession(sessionOptions(command));
  expect(pending).rejects.toThrow("extension reported example.refusal");
  expect(pending).rejects.not.toThrow("private diagnostic");
  expect(pending).rejects.not.toThrow("private extension detail");
  await pending.catch(() => undefined);
});

async function changingExtension(method: "describe" | "resolve") {
  const root = await temporaryFixture(
    join(tmpdir(), "sevro-extension-quality-"),
  );

  const source = join(root, "extension.ts");
  const declared = join(root, "declared-source.txt");
  const fixture = await readFile(
    join(import.meta.dir, "../../fixtures/extension.ts"),
    "utf8",
  );
  const mutation = `\nif (request.method === ${JSON.stringify(method)}) await Bun.write(${JSON.stringify(declared)}, "changed during method");\n`;
  await writeFile(source, fixture + mutation);
  await writeFile(declared, "stable declared source");
  return {
    declared,
    options: {
      command: [process.execPath, source, "lifecycle"],
      sourceFiles: [source, declared],
      configuration: {},
      redactedConfiguration: {},
      engineCapabilities: ["sevro.host.exec"],
      hostCapabilities: [],
    },
  };
}

test("refuses a source change made by the extension during discovery", async () => {
  const extension = await changingExtension("describe");
  const pending = openExtensionSession(extension.options);
  expect(pending).rejects.toThrow("extension source changed during discovery");
  await pending.catch(() => undefined);
  expect(await readFile(extension.declared, "utf8")).toBe(
    "changed during method",
  );
});

test("refuses a source change made during resolve even after a valid response", async () => {
  const extension = await changingExtension("resolve");
  const session = await openExtensionSession(extension.options);
  const pending = session.resolve("file:///tmp/project", {});
  expect(pending).rejects.toThrow("extension source changed during run");
  await pending.catch(() => undefined);
  expect(await readFile(extension.declared, "utf8")).toBe(
    "changed during method",
  );
});

test("refuses duplicate resolved case IDs from a schema-valid extension", async () => {
  const session = await openExtensionSession(
    wireOptions({ resolve: { cases: [wireCase, wireCase] } }),
  );
  expect(session.resolve("file:///tmp/project", {})).rejects.toThrow(
    "duplicate case IDs",
  );
});

const resultRefusals = [
  {
    name: "foreign result ID",
    result: {
      checks: [
        {
          id: "another.extension.ready",
          status: "passed",
          evidenceRefs: ["example.evidence"],
        },
      ],
      metrics: [],
    },
    diagnostic: "duplicate or foreign result IDs",
  },
  {
    name: "duplicate check and domain IDs",
    result: {
      checks: [
        {
          id: "example.extension.ready",
          status: "passed",
          evidenceRefs: ["example.evidence"],
        },
      ],
      domainOutcomes: [
        {
          id: "example.extension.ready",
          status: "passed",
          evidenceRefs: ["example.evidence"],
        },
      ],
      metrics: [],
    },
    diagnostic: "duplicate or foreign result IDs",
  },
  {
    name: "unsolicited task policy",
    result: { checks: [], metrics: [], taskVerdictRecommendation: "passed" },
    diagnostic: "task policy was not selected",
  },
];

for (const refusal of resultRefusals) {
  test(`refuses ${refusal.name} through the public extension session`, async () => {
    const session = await openExtensionSession(
      wireOptions({ evaluate: refusal.result }),
    );
    expect(session.evaluate(wireEvaluationRequest())).rejects.toThrow(
      refusal.diagnostic,
    );
  });
}

test("refuses an advertised selected policy when its recommendation is omitted", async () => {
  const session = await openExtensionSession({
    ...wireOptions(),
    taskVerdictPolicy: "example.policy",
  });
  expect(session.evaluate(wireEvaluationRequest())).rejects.toThrow(
    "omitted the selected task policy recommendation",
  );
});

test("refuses a task policy that was never advertised", () => {
  expect(
    openExtensionSession({
      ...wireOptions(),
      taskVerdictPolicy: "another.policy",
    }),
  ).rejects.toThrow("did not advertise the selected task policy");
});

for (const completeness of ["partial", "unavailable"] as const) {
  test(`refuses passed extension results citing ${completeness} observations`, async () => {
    const session = await openExtensionSession(wireOptions());
    const request = wireEvaluationRequest();
    const complete = await session.evaluate(request);
    expect(complete.checks[0]?.status).toBe("passed");
    request.observations = request.observations.map((item) => ({
      ...item,
      completeness,
    }));
    expect(session.evaluate(request)).rejects.toThrow(
      "passed a result with incomplete evidence",
    );
  });
}

test("allows complete artifact evidence but refuses an unavailable built-in check as passing evidence", async () => {
  const session = await openExtensionSession(wireOptions());
  const request = wireEvaluationRequest();
  request.observations = [];
  request.artifacts = [
    {
      id: "example.evidence",
      path: "file:///tmp/retained",
      sha256: "a".repeat(64),
    },
  ];
  expect((await session.evaluate(request)).checks[0]?.status).toBe("passed");
  request.artifacts = [];
  request.builtinChecks = [
    { id: "example.evidence", status: "unavailable", evidenceRefs: [] },
  ];
  expect(session.evaluate(request)).rejects.toThrow(
    "passed a result with incomplete evidence",
  );
});

test("refuses duplicate replacement declarations before extension launch", () => {
  expect(
    openExtensionSession({
      ...wireOptions(),
      replaceBuiltinGraders: ["sevro.regex", "sevro.regex"],
    }),
  ).rejects.toThrow("duplicate built-in grader replacement");
});

test("refuses unreadable declared extension source without launching discovery", () => {
  expect(
    openExtensionSession({
      ...wireOptions(),
      sourceFiles: ["/does/not/exist/source.ts"],
    }),
  ).rejects.toThrow("declared extension source is unreadable");
});
