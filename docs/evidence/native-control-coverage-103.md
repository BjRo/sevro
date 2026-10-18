# Native control coverage regression evidence

This records the test-first repair for [issue #103](https://github.com/BjRo/sevro/issues/103).
The public seam is the Codex native-session observation projected into
`sevro.host.native-controls`. Independent oracles are the submitted literal tool
labels, explicitly successful direct spawn receipts, and the absence of any
launch expression in ordinary shell/output programs. The observer never executes
submitted JavaScript. See the [observation contract](../native-controls.md).

## Observed red/green slices

Each red ran with the new test present and the corresponding product behavior
unchanged. Each green used the identical command after the minimal repair.
All five reds failed on the intended missing behavior, rather than setup errors.

1. Red — `bun test tests/codex-native-calls.test.ts -t "JSON serialization"`:
   expected complete inspection, received partial.
   Green — `bun test tests/codex-native-calls.test.ts -t "JSON serialization"`:
   1 passed.
2. Red — `bun test tests/codex-native-calls.test.ts -t "conditional batch-result"`:
   expected complete inspection, received partial.
   Green — `bun test tests/codex-native-calls.test.ts -t "conditional batch-result"`:
   1 passed.
3. Red — `bun test tests/codex-native-calls.test.ts -t "numeric batch-output"`:
   expected complete inspection, received partial.
   Green — `bun test tests/codex-native-calls.test.ts -t "numeric batch-output"`:
   1 passed.
4. Red — `bun test tests/codex-native-calls.test.ts -t "separates truncated output"`:
   expected complete source coverage despite truncated shell output, received partial.
   Green — `bun test tests/codex-native-calls.test.ts -t "separates truncated output"`:
   1 passed.
5. Red — `bun test tests/codex-native-calls.test.ts -t "direct acceptance facts"`:
   missing scoped direct acceptance count and coverage, with known native count
   and truncation fields incorrectly nulled by a dynamic exec submission.
   Green — `bun test tests/codex-native-calls.test.ts -t "direct acceptance facts"`:
   1 passed.

Additional observer regressions distinguish failed execution from malformed
source, genuine native capture gaps, rejected versus accepted direct attempts,
and dynamic calls hidden inside output loops or conditional expressions.
Faithful batch fixtures exercise `Promise.all`, `Promise.allSettled`, result-field
printing, output-only `if` branches, numeric indexing, `String`, object spread,
and `JSON.stringify`. Host adapter fixtures exercise serialized and truncated
reads through the retained portable observation.

## Retained trace reinspection

On 2026-10-18, the candidate observer reinspected all 15 retained candidate
transcript bundles for the three audit cases in the ticket. Exact decoded native
JSONL bytes were copied into disposable session homes; original bundles and
saved trial results were read-only. These are observer replay results, not fresh
candidate trials or regraded task outcomes. No model was launched. Private raw
transcripts and replay tooling remain outside Git.

All 15 native-session observations remained complete. All ordinary formatting and
truncation gaps disappeared. The eight previously affected trials now expose:

| Case                       | Trial | Exec source coverage | Remaining partial ordinal/reason | Direct spawn attempts | Verified direct acceptances |
| -------------------------- | ----- | -------------------- | -------------------------------- | --------------------- | --------------------------- |
| empty-diff                 | 1     | complete             | none                             | 0                     | 0                           |
| empty-diff                 | 2     | complete             | none                             | 0                     | 0                           |
| invalid-base               | 1     | complete             | none                             | 0                     | 0                           |
| invalid-base               | 3     | complete             | none                             | 0                     | 0                           |
| reviewer-route-unavailable | 1     | partial              | 93 / malformed_source            | 2                     | 0                           |
| reviewer-route-unavailable | 2     | complete             | none                             | 0                     | 0                           |
| reviewer-route-unavailable | 3     | partial              | 112 / malformed_source           | 2                     | 0                           |
| reviewer-route-unavailable | 4     | complete             | none                             | 2                     | 0                           |

The two malformed submissions retain `execution: failed`, `output: complete`,
and `inspectionReason: malformed_source`; source absence remains unproven.
Their native attempt labels remain usable. Darrow's separate consumer must
evaluate positive prohibited attempts before gating an absence pass on full
coverage; no Darrow consumer or historical scores were changed here.

SHA-256 identifies the exact input bundle for each affected trial:

| Case/trial                   | Bundle SHA-256                                                     |
| ---------------------------- | ------------------------------------------------------------------ |
| empty-diff/1                 | `4d4a8ce18675f0d705ec582891e6ea483dc8c1c92d50b1480d55e1a570417437` |
| empty-diff/2                 | `63c51a69546c7c8a3aa38793f512544b065b0ac9d7ad4ff30ce0b0f9bad4693f` |
| invalid-base/1               | `f2cab76a8fce19171124e9de8fc9f75b68a25250104ee07ed0746a919d438842` |
| invalid-base/3               | `0d3206ff990a0f41d764f564827f8b76e22da64cd2a51f939074f47b97a3dbd5` |
| reviewer-route-unavailable/1 | `db54a066c7ac610e1b90ff41a23fee64c5d4844d4e13ded40f3ec3ae5668aec4` |
| reviewer-route-unavailable/2 | `6c75224e6ce8b57c2e99924b8676dc351c2173029d33c8f746688bd5fb5fe926` |
| reviewer-route-unavailable/3 | `c2b4e179f5740670fc4faab71e7060d36890ddb2e7f4c76f3eca21f437fc4525` |
| reviewer-route-unavailable/4 | `31f45b24f6219fc837afa5e311029f1c55e6b518941917d9bc3a73aed706591f` |
