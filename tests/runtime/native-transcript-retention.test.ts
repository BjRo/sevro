import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { runEvaluation, type HostAdapter } from "../../src/engine";
import { parseRunEvidence } from "../fixtures/assertions";
import { defined } from "../fixtures/assertions";
import { nativeRoot } from "../fixtures/runtime-host-fixtures";
import { createCodexFixture } from "../fixtures/runtime-host-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const codexFixture = createCodexFixture(roots);

const retainedNativeBundle = {
  format: "sevro.native-transcripts.v1",
  host: "codex",
  role: "candidate",
  rootSessionId: "runtime-test",
  completeness: "complete",
  issues: [],
  files: [
    {
      path: "rollout-runtime-test.jsonl",
      sha256: createHash("sha256").update(nativeRoot).digest("hex"),
      bytesBase64: Buffer.from(nativeRoot).toString("base64"),
    },
  ],
};

function gzipFile(path: string, bytes: Buffer) {
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gzipBase64: gzipSync(bytes).toString("base64"),
  };
}

const compressedNativeFile = gzipFile(
  "rollout-runtime-test.jsonl",
  Buffer.from(nativeRoot),
);

function retainedEvidenceHost(bundle: unknown): HostAdapter {
  return {
    id: "native-evidence.fixture",
    model: "fixture",
    effort: "low",
    run() {
      return Promise.resolve({
        complete: true,
        finalMessage: "ready",
        artifacts: [
          {
            id: "sevro.native-transcripts.bundle",
            bytes: Buffer.from(JSON.stringify(bundle)),
          },
        ],
      });
    },
  };
}

test.each([
  {
    label: "unsupported format",
    bundle: { ...retainedNativeBundle, format: "unknown" },
  },
  {
    label: "unsupported host",
    bundle: { ...retainedNativeBundle, host: "unknown" },
  },
  {
    label: "non-array files",
    bundle: { ...retainedNativeBundle, files: {} },
  },
  {
    label: "invalid file record",
    bundle: { ...retainedNativeBundle, files: [null] },
  },
  {
    label: "tampered native bytes",
    bundle: {
      ...retainedNativeBundle,
      files: [
        {
          ...defined(retainedNativeBundle.files[0]),
          bytesBase64: Buffer.from("altered evidence").toString("base64"),
        },
      ],
    },
  },
  {
    label: "decompressed total above native byte limit",
    bundle: {
      ...retainedNativeBundle,
      format: "sevro.native-transcripts.v2",
      files: [
        gzipFile("rollout-runtime-test.jsonl", Buffer.alloc(3 * 1024 * 1024)),
        gzipFile("child.jsonl", Buffer.alloc(3 * 1024 * 1024)),
      ],
    },
  },
  {
    label: "missing v2 gzip payload",
    bundle: { ...retainedNativeBundle, format: "sevro.native-transcripts.v2" },
  },
  {
    label: "decompressed bytes after exhausted native limit",
    bundle: {
      ...retainedNativeBundle,
      format: "sevro.native-transcripts.v2",
      files: [
        gzipFile("rollout-runtime-test.jsonl", Buffer.alloc(5 * 1024 * 1024)),
        gzipFile("child.jsonl", Buffer.from([1])),
      ],
    },
  },
  {
    label: "corrupt v2 gzip payload",
    bundle: {
      ...retainedNativeBundle,
      format: "sevro.native-transcripts.v2",
      files: [
        {
          ...compressedNativeFile,
          gzipBase64: Buffer.from("not gzip").toString("base64"),
        },
      ],
    },
  },
  {
    label: "truncated v2 gzip payload",
    bundle: {
      ...retainedNativeBundle,
      format: "sevro.native-transcripts.v2",
      files: [
        {
          ...compressedNativeFile,
          gzipBase64: Buffer.from(compressedNativeFile.gzipBase64, "base64")
            .subarray(0, -4)
            .toString("base64"),
        },
      ],
    },
  },
  {
    label: "tampered decompressed v2 bytes",
    bundle: {
      ...retainedNativeBundle,
      format: "sevro.native-transcripts.v2",
      files: [
        {
          ...gzipFile(
            compressedNativeFile.path,
            Buffer.from("altered evidence"),
          ),
          sha256: compressedNativeFile.sha256,
        },
      ],
    },
  },
])(
  "evaluation refuses $label retained native evidence before grading",
  async ({ bundle }) => {
    const { root } = await codexFixture();
    const graderCalls: string[] = [];
    const host = retainedEvidenceHost(bundle);
    const semanticHost: HostAdapter = {
      ...host,
      id: "native-evidence.grader",
      run() {
        graderCalls.push("called");
        return Promise.reject(
          new Error("invalid native evidence reached grading"),
        );
      },
    };
    const evaluation = runEvaluation(
      retainedNativeEvaluation(root, host, semanticHost),
    );
    expect(evaluation).rejects.toThrow(/native transcript/);
    await evaluation.catch(() => undefined);
    expect(graderCalls).toEqual([]);
  },
);

test("evaluation decodes v2 files at the native byte limit including empty files", async () => {
  const { root } = await codexFixture();
  const original = Buffer.alloc(5 * 1024 * 1024, 255);
  const host = retainedEvidenceHost({
    ...retainedNativeBundle,
    format: "sevro.native-transcripts.v2",
    files: [
      gzipFile("rollout-runtime-test.jsonl", original),
      gzipFile("empty.bin", Buffer.alloc(0)),
    ],
  });
  const semanticHost: HostAdapter = {
    ...host,
    id: "native-evidence.boundary-consumer",
    async run(request) {
      const view = defined(request.candidateTranscriptRoot);
      expect(
        await readFile(join(view, "codex/rollout-runtime-test.jsonl")),
      ).toEqual(original);
      expect(await readFile(join(view, "codex/empty.bin"))).toEqual(
        Buffer.alloc(0),
      );
      return {
        complete: true,
        finalMessage: JSON.stringify({
          checks: [
            {
              id: "native-evidence",
              verdict: "pass",
              reason: "Exact bounded native bytes",
            },
          ],
        }),
      };
    },
  };
  const { result } = await runEvaluation(
    retainedNativeEvaluation(root, host, semanticHost),
  );
  expect(result.task.verdict).toBe("passed");
});

test.each(["v1", "v2"])(
  "evaluation supplies verified Claude native bytes from %s to a retained-evidence consumer",
  async (version) => {
    const { root } = await codexFixture();
    const bytes =
      '{"type":"assistant","message":{"model":"fixture","content":[]}}';
    const host: HostAdapter = {
      id: "claude-evidence.fixture",
      model: "fixture",
      effort: "low",
      run() {
        return Promise.resolve({
          complete: true,
          finalMessage: "ready",
          artifacts: [
            {
              id: "sevro.native-transcripts.bundle",
              bytes: Buffer.from(
                JSON.stringify({
                  ...retainedNativeBundle,
                  format: `sevro.native-transcripts.${version}`,
                  host: "claude",
                  files: [
                    {
                      path: "project/runtime-test.jsonl",
                      sha256: createHash("sha256").update(bytes).digest("hex"),
                      ...(version === "v1"
                        ? { bytesBase64: Buffer.from(bytes).toString("base64") }
                        : {
                            gzipBase64: gzipSync(Buffer.from(bytes)).toString(
                              "base64",
                            ),
                          }),
                    },
                  ],
                }),
              ),
            },
          ],
        });
      },
    };
    const semanticHost: HostAdapter = {
      ...host,
      id: "claude-evidence.consumer",
      async run(request) {
        const view = defined(request.candidateTranscriptRoot);
        expect(
          await readFile(
            join(view, "claude/project/runtime-test.jsonl"),
            "utf8",
          ),
        ).toBe(bytes);
        return {
          complete: true,
          finalMessage: JSON.stringify({
            checks: [
              {
                id: "native-evidence",
                verdict: "pass",
                reason: "Verified native bytes",
              },
            ],
          }),
        };
      },
    };
    const { result } = await runEvaluation(
      retainedNativeEvaluation(root, host, semanticHost),
    );
    expect(result.task.verdict).toBe("passed");
  },
);

function retainedNativeEvaluation(
  root: string,
  host: HostAdapter,
  semanticHost: HostAdapter,
) {
  return {
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1" as const,
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
    case: {
      id: "retained-native-integrity",
      prompt: "Return ready",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "native-evidence",
          grader: "sevro.semantic",
          configuration: { proposition: "Native evidence is verified" },
        },
      ],
    },
  };
}

test("evaluation exposes retained native evidence to isolated shell and semantic consumers", async () => {
  const { host, root } = await codexFixture();
  const semanticHost: HostAdapter = {
    id: "transcript.semantic",
    model: "fixture",
    effort: "low",
    async run(request) {
      const view = request.candidateTranscriptRoot;
      const content = view
        ? await readFile(
            join(view, "codex", "rollout-runtime-test.jsonl"),
            "utf8",
          )
        : "missing";
      return {
        complete: true,
        finalMessage: JSON.stringify({
          checks: [
            {
              id: "semantic",
              verdict: content === nativeRoot ? "pass" : "fail",
              reason: "Retained native evidence",
            },
          ],
        }),
      };
    },
  };
  const { result } = await runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
    shellIsolation: { protectedRoots: [] },
    case: {
      id: "transcript-consumers",
      prompt: "Return ready",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "shell",
          grader: "sevro.shell",
          configuration: {
            run: 'cat "$SEVRO_CANDIDATE_TRANSCRIPTS/codex/rollout-runtime-test.jsonl"; ! printf changed > "$SEVRO_CANDIDATE_TRANSCRIPTS/codex/rollout-runtime-test.jsonl"',
            expectExact: nativeRoot,
          },
        },
        {
          id: "semantic",
          grader: "sevro.semantic",
          configuration: { proposition: "Transcript is available" },
        },
      ],
    },
  });
  expect(result.task.verdict).toBe("passed");
});

test("evaluation retains native transcript artifacts when cancellation follows host completion", async () => {
  const { root, host } = await codexFixture();
  const controller = new AbortController();
  const cancellingHost: HostAdapter = {
    ...host,
    async run(request) {
      const result = await host.run(request);
      controller.abort();
      return result;
    },
  };
  const { result } = await runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host: cancellingHost,
    signal: controller.signal,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
    case: {
      id: "cancelled-transcripts",
      prompt: "Return ready",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [],
    },
  });
  expect(result.execution.status).toBe("cancelled");
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(
    defined(evidence.trials[0]).artifactRefs.some(
      (item) => item.id === "sevro.native-transcripts.bundle",
    ),
  ).toBe(true);
});
