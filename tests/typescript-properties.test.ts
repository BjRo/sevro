import { expect, test } from "bun:test";
import fc from "fast-check";
import { canonicalJson, hashJson } from "../src/identity";
import { summarizeCodexEvents } from "../src/hosts/codex-events";
import { assertCliResult } from "../src/schema";

const settings = { seed: 20261007, numRuns: 200, endOnFailure: true };

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
