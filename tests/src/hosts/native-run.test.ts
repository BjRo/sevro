import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  array,
  defined,
  parseRecord,
  record,
  string,
} from "../../fixtures/assertions";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runNativeRun,
  type NativeRunAdapter,
  type NativeRunContext,
} from "../../../src/hosts/index";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

async function fixture() {
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-native-run-test-"),
  );
  const stages: string[] = [];
  let stateRoot = "";
  const adapter: NativeRunAdapter<string, string> = {
    host: "claude",
    transcriptDirectory: "native-home/projects",
    hookPosition: "last",
    validate(request) {
      stages.push("admission");
      return Promise.resolve(request.prompt);
    },
    async prepare(context, prompt) {
      stateRoot = context.stateRoot;
      roots.push(stateRoot);
      stages.push(context.diagnostics.stage);
      await writeFile(join(stateRoot, "prepared"), prompt);
      return prompt;
    },
    async execute(context, prompt) {
      stages.push("turns");
      expect(await Bun.file(join(context.stateRoot, "prepared")).text()).toBe(
        "ready",
      );
      return {
        result: { finalMessage: prompt, complete: true },
        observations: [],
      };
    },
  };
  return {
    adapter,
    stages,
    request: { prompt: "ready", workspace, condition: "passive" as const },
    stateRoot: () => stateRoot,
  };
}

test("native run prepares, executes and assembles a passive host result", async () => {
  const f = await fixture();
  const result = await runNativeRun(f.adapter, f.request);
  expect(result).toEqual({
    finalMessage: "ready",
    complete: true,
    actualCondition: "passive",
    observations: [],
  });
  expect(f.stages).toEqual(["admission", "state-preparation", "turns"]);
});

async function ownedResources(context: NativeRunContext, stages: string[]) {
  const helper = join(context.stateRoot, "helper");
  await mkdir(helper);
  await mkdir(join(context.stateRoot, "receipts"));
  context.cleanupRoots.push(helper);
  context.hooks = {
    directories: [],
    receipts: join(context.stateRoot, "receipts"),
    plugins: [],
    isolation: [
      {
        argv: [],
        release() {
          expect(existsSync(context.stateRoot)).toBe(true);
          expect(existsSync(helper)).toBe(true);
          stages.push("hooks-released");
          return Promise.resolve();
        },
      },
    ],
  };
}

test("native run releases hooks before removing state and helper roots", async () => {
  const f = await fixture();
  const prepare = f.adapter.prepare;
  f.adapter.prepare = async (context, prompt) => {
    await ownedResources(context, f.stages);
    return prepare(context, prompt);
  };
  await runNativeRun(f.adapter, f.request);
  expect(f.stages.at(-1)).toBe("hooks-released");
  expect(existsSync(f.stateRoot())).toBe(false);
});

for (const phase of ["preparation", "turns"] as const) {
  test(`native run retains ${phase} failure diagnostics before cleanup`, async () => {
    const f = await fixture();
    f.adapter.retainHostDiagnostics = true;
    const prepare = f.adapter.prepare;
    f.adapter.prepare = async (context, prompt) => {
      const state = await prepare(context, prompt);
      await ownedResources(context, f.stages);
      if (phase === "preparation") throw new Error("preparation failed");
      return state;
    };
    f.adapter.execute = (context) => {
      context.diagnostics.stage = "fake-turns";
      throw new Error("turns failed");
    };
    const captured: string[] = [];
    const result = await runNativeRun(f.adapter, {
      ...f.request,
      retainHostDiagnostics(bytes) {
        expect(existsSync(f.stateRoot())).toBe(true);
        captured.push(Buffer.from(bytes).toString());
        return Promise.resolve();
      },
    });
    expect(result.complete).toBe(false);
    expect(result.executionFailed).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(
      phase === "preparation"
        ? '"stage":"state-preparation"'
        : '"stage":"fake-turns"',
    );
    expect(captured[0]).toContain(`${phase} failed`);
    expect(f.stages.at(-1)).toBe("hooks-released");
    expect(existsSync(f.stateRoot())).toBe(false);
  });
}

for (const failure of [false, true]) {
  test(`native run retains exact transcript bytes on ${failure ? "failure" : "success"}`, async () => {
    const f = await fixture();
    const native = '{"type":"assistant","message":"preserve me"}\n';
    const prepare = f.adapter.prepare;
    f.adapter.prepare = async (context, prompt) => {
      const state = await prepare(context, prompt);
      const directory = join(
        context.stateRoot,
        f.adapter.transcriptDirectory,
        "project",
      );
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "session.jsonl"), native);
      return state;
    };
    f.adapter.execute = () => {
      if (failure) throw new Error("turn failed");
      return Promise.resolve({
        result: { finalMessage: "ready", complete: true },
        observations: [
          {
            id: "sevro.host.native-goal",
            completeness: "complete",
            data: { threadId: "session" },
          },
        ],
      });
    };
    const result = await runNativeRun(f.adapter, {
      ...f.request,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts: true,
      },
    });
    const artifact = result.artifacts?.find(
      (item) => item.id === "sevro.native-transcripts.bundle",
    );
    expect(artifact).toBeDefined();
    const bundle = parseRecord(Buffer.from(defined(artifact).bytes).toString());
    const file = record(array(bundle.files)[0]);
    expect(
      gunzipSync(Buffer.from(string(file.gzipBase64), "base64")).toString(),
    ).toBe(native);
    expect(bundle.completeness).toBe(failure ? "partial" : "complete");
    expect(existsSync(f.stateRoot())).toBe(false);
  });
}

for (const position of ["first", "last"] as const) {
  test(`native run incorporates hooks exactly once at the ${position} observation position`, async () => {
    const f = await fixture();
    f.adapter.hookPosition = position;
    const prepare = f.adapter.prepare;
    f.adapter.prepare = async (context, prompt) => {
      const state = await prepare(context, prompt);
      await ownedResources(context, f.stages);
      return state;
    };
    f.adapter.execute = () =>
      Promise.resolve({
        result: {
          finalMessage: "ready",
          complete: true,
          inputTokens: null,
          outputTokens: 3,
          usageComplete: false,
        },
        beforeRuntime: [{ id: "before", completeness: "complete", data: {} }],
        observations: [{ id: "after", completeness: "partial", data: {} }],
      });
    const result = await runNativeRun(f.adapter, {
      ...f.request,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
      },
    });
    const ids = result.observations?.map((item) => item.id);
    const observations = ["before", "sevro.host.runtime", "after"];
    expect(ids).toEqual(
      position === "first"
        ? ["sevro.host.hooks", ...observations]
        : [...observations, "sevro.host.hooks"],
    );
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBe(3);
    expect(result.usageComplete).toBe(false);
  });
}

test("native run retains an incomplete result and redacts credentials", async () => {
  const f = await fixture();
  const credentialFile = join(f.request.workspace, "auth.json");
  await writeFile(
    credentialFile,
    JSON.stringify({ OPENAI_API_KEY: "synthetic-secret-token" }),
  );
  f.adapter.credentialFile = credentialFile;
  f.adapter.retainHostDiagnostics = true;
  f.adapter.execute = (context) => {
    context.diagnostics.failure = new Error(
      "failed with synthetic-secret-token",
    );
    return Promise.resolve({
      result: { finalMessage: null, complete: false, executionFailed: true },
      observations: [],
    });
  };
  const result = await runNativeRun(f.adapter, f.request);
  const diagnostics = defined(
    result.artifacts?.find((item) => item.id === "sevro.host.diagnostics"),
  );
  const text = Buffer.from(diagnostics.bytes).toString();
  expect(text).toContain("failed with [redacted]");
  expect(text).not.toContain("synthetic-secret-token");
  expect(existsSync(f.stateRoot())).toBe(false);
});

test("native run rejects common admission before the host adapter allocates resources", async () => {
  const f = await fixture();
  expect(
    runNativeRun(f.adapter, { ...f.request, followUpPrompt: "" }),
  ).rejects.toThrow("Claude follow-up prompt must be nonempty");
  expect(f.stages).toEqual([]);
  expect(f.stateRoot()).toBe("");
});
