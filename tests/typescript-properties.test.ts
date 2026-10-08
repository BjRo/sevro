import { expect, test } from "bun:test";
import fc from "fast-check";
import { canonicalJson, hashJson } from "../src/identity";
import { summarizeCodexEvents } from "../src/hosts/codex-events";
import { assertCliResult } from "../src/schema";
import { prepareRepositoryFixture } from "../src/repository-fixture";
import { prepareGeneratedFixture } from "../src/generated-fixture";
import { resolvedFixture } from "../src/resolved-case";

const settings = { seed: 20261007, numRuns: 200, endOnFailure: true };

test("resolved minimal repository fixtures preserve the source reference without inventing overlays or tools", () => {
  const fixture = prepareRepositoryFixture({
    kind: "repository",
    sourceRef: "source",
  });
  const before = canonicalJson(fixture);
  const translated = resolvedFixture(fixture);
  expect(translated).toEqual({ sourceRef: "source" });
  expect(Object.keys(translated)).toEqual(["sourceRef"]);
  expect(
    prepareRepositoryFixture({ kind: "repository", ...translated }),
  ).toEqual(fixture);
  expect(canonicalJson(fixture)).toBe(before);
});

const repositoryDeclarations = fc
  .record(
    {
      kind: fc.constant("repository"),
      sourceRef: fc.constantFrom("source", "baseline", "project"),
      files: fc.dictionary(
        fc.constantFrom("notes.txt", "assets/review.txt"),
        fc.string({ maxLength: 64 }),
        { minKeys: 1, maxKeys: 2 },
      ),
      staged: fc.constant(["notes.txt"]),
      commitFiles: fc.constant(true),
      hooks: fc.dictionary(
        fc.constantFrom("pre-commit", "post-checkout"),
        fc.constantFrom("#!/bin/sh\nexit 0\n", "#!/bin/sh\necho checked\n"),
        { minKeys: 1, maxKeys: 2 },
      ),
      bin: fc.dictionary(
        fc.constantFrom("review-tool", "Ticket_Stub"),
        fc.constantFrom("#!/bin/sh\necho ready\n", "#!/bin/sh\nexit 0\n"),
        { minKeys: 1, maxKeys: 2 },
      ),
    },
    { requiredKeys: ["kind", "sourceRef"] },
  )
  .map((declaration) => {
    if (declaration.staged || declaration.commitFiles)
      declaration.files = {
        ...declaration.files,
        "notes.txt": "declared staged content\n",
      };
    return prepareRepositoryFixture(declaration);
  });

test("resolved repository fixtures preserve optional overlay, staging, and tool declarations without mutating negotiated data", () => {
  fc.assert(
    fc.property(repositoryDeclarations, (fixture) => {
      const before = canonicalJson(fixture);
      const expected: unknown = Object.fromEntries(
        Object.entries(fixture).filter(([key]) => key !== "kind"),
      );
      const translated = resolvedFixture(fixture);
      expect(canonicalJson(translated)).toBe(canonicalJson(expected));
      expect(canonicalJson(fixture)).toBe(before);
      expect(
        prepareRepositoryFixture({ kind: "repository", ...translated }),
      ).toEqual(fixture);
    }),
    settings,
  );
});

test("resolved inline and generated fixtures retain their declared bytes and history", () => {
  const inline = {
    kind: "inline" as const,
    files: { "notes.txt": "inline content\n" },
  };
  const generated = prepareGeneratedFixture({
    kind: "generated",
    commits: [{ message: "Baseline", files: { "README.md": "baseline\n" } }],
    files: { "notes.txt": "working tree\n" },
    staged: ["notes.txt"],
  });
  const before = canonicalJson({ inline, generated });
  expect(resolvedFixture(inline)).toEqual({ files: inline.files });
  expect(resolvedFixture(generated)).toEqual(generated);
  expect(canonicalJson({ inline, generated })).toBe(before);
});

test("canonical JSON round trips and hashes remain stable across key order", () => {
  fc.assert(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (value) => {
      const reordered = Object.fromEntries(Object.entries(value).reverse());
      expect(canonicalJson(value)).toBe(canonicalJson(reordered));
      expect(hashJson(value)).toBe(hashJson(reordered));
      const roundTrip: unknown = JSON.parse(canonicalJson(value));
      const normalized: unknown = JSON.parse(JSON.stringify(value));
      expect(roundTrip).toEqual(normalized);
      expect(canonicalJson(roundTrip)).toBe(canonicalJson(value));
    }),
    settings,
  );
});

test("Codex JSONL preserves Unicode messages and exact cumulative token counts", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.string(),
      fc.nat({ max: Number.MAX_SAFE_INTEGER }),
      fc.nat({ max: Number.MAX_SAFE_INTEGER }),
      (thread, message, input, output) => {
        const stream = [
          { type: "thread.started", thread_id: thread },
          {
            type: "item.completed",
            item: { type: "agent_message", text: message },
          },
          {
            type: "turn.completed",
            usage: { input_tokens: input, output_tokens: output },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n");
        expect(summarizeCodexEvents(`\n${stream}\n\n`, 0)).toEqual({
          threadId: thread,
          complete: true,
          finalMessage: message,
          inputTokens: input,
          outputTokens: output,
          usageComplete: true,
        });
        expect(summarizeCodexEvents(stream, 1).complete).toBe(false);
      },
    ),
    settings,
  );
});

test("CLI schemas preserve unassessed outcomes across serialization and reject lost required state", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.constantFrom("completed", "failed", "cancelled", "not_run"),
      fc.constantFrom("completed", "error", "unavailable", "not_requested"),
      fc.constantFrom(
        "format",
        "runId",
        "execution",
        "grading",
        "task",
        "exitCode",
        "evidencePath",
        "cases",
      ),
      (caseId, execution, grading, required) => {
        const value = {
          format: "sevro.cli-result.v1",
          runId: null,
          execution: { status: execution },
          grading: { status: grading },
          task: { verdict: "not_assessed" },
          exitCode: 64,
          evidencePath: null,
          cases: [
            {
              caseId,
              execution: { status: execution },
              grading: { status: grading },
              task: { verdict: "not_assessed" },
              trials: [],
            },
          ],
        };
        assertCliResult(value);
        const roundTrip: unknown = JSON.parse(JSON.stringify(value));
        assertCliResult(roundTrip);
        expect(roundTrip).toEqual(value);
        Reflect.deleteProperty(value, required);
        expect(() => {
          assertCliResult(value);
        }).toThrow("invalid Sevro CLI result");
      },
    ),
    settings,
  );
});
