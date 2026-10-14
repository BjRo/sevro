# Code Mode control evidence for issue 71

On 2026-10-14, the implementation for [issue 71](https://github.com/BjRo/sevro/issues/71)
replayed the four retained complete Codex native transcript bundles named in
that ticket through the changed Sevro observers. This is artifact rechecking,
not a fresh authenticated model trial. The original task checks and activation
outcomes were preserved separately from the new control-absence assessment.
Private native bundles, commands and output remain outside Git.

| Case                                   | Inspected exec submissions | Submitted tool calls | Rechecked control absence | Original task checks    | Original activation |
| -------------------------------------- | -------------------------- | -------------------- | ------------------------- | ----------------------- | ------------------- |
| guide-mutation                         | 2                          | 4                    | passed                    | 7 passed, 1 unavailable | passed              |
| guide-orchestration                    | 3                          | 6                    | passed                    | 8 passed, 1 unavailable | passed              |
| code-review-empty-diff                 | 6                          | 8                    | passed                    | 6 passed, 1 unavailable | passed              |
| code-review-reviewer-route-unavailable | 11                         | 12                   | passed                    | 6 passed, 1 unavailable | unavailable         |

The recheck found no submitted agent launch or prohibited goal mutation in any
case. All submission receipts had complete inspection and matching native
ordinals. No accepted-agent count was substituted for invocation evidence.
The older Darrow consumer still requires zero submitted exec calls; it needs
to adopt the [receipt validation contract](../native-controls.md) to grade
these new observations. Its original unavailable outcomes were not rewritten.

The reviewer-route case's first read used a literal Git environment reset and
repository-root query before its final mounted skill read. Its retained output
ended with the exact 20,627-character skill body still present in the Darrow
validation checkout. Rehydrating that independently matching mount and rebasing
its expired private path let the changed skill-read observer establish a
complete `code-review` receipt. This rechecked skill-file receipt is separate
from the original unavailable activation outcome; no historical trial was
changed to passed.

Durable Bun regressions exercise the host's public observations for completed
and rejected submissions, opaque code, and the repository-prefixed skill read.
Additional real session/file regressions cover malformed/truncated completion,
missing and duplicate receipts, forged textual labels, ambiguous code, namespace
and size limits, and contradictory receipt counts/ordinals. Existing integration
tests remain in place.

## Observed test-first slices

Each command below was run with its new regression present and its corresponding
product behavior unchanged, then rerun after the product fix. Commands invoke
the existing Bun harness; the shell routed their output through lean-ctx.

1. Red — `bun test tests/codex-native-calls.test.ts -t "Code Mode exposes completed literal"`: missing submitted-call inventory.
   Green — `bun test tests/codex-native-calls.test.ts -t "Code Mode exposes completed literal"`: 1 passed.
2. Red — `bun test tests/codex-native-calls.test.ts -t "Code Mode portable"`: rejected request receipt missing and opaque submission reported complete.
   Green — `bun test tests/codex-native-calls.test.ts -t "Code Mode portable"`: 2 passed.
3. Red — `bun test tests/codex-native-calls.test.ts -t "Code Mode inspects the retained"`: both retained parallel-read shapes reported partial.
   Green — `bun test tests/codex-native-calls.test.ts -t "Code Mode inspects the retained"`: 2 passed.
4. Red — `bun test tests/codex-native-calls.test.ts -t "Code Mode refuses malformed"`: malformed and truncated completion envelopes reported complete.
   Green — `bun test tests/codex-native-calls.test.ts -t "Code Mode refuses malformed"`: 2 passed.
5. Red — `bun test tests/codex-native-calls.test.ts -t "Code Mode accepts native array"`: the native array envelope reported partial.
   Green — `bun test tests/codex-native-calls.test.ts -t "Code Mode accepts native array"`: 1 passed.
6. Red — `bun test tests/codex-host.test.ts -t "reviewer-route repository-prefixed"`: complete mounted body did not establish a skill read.
   Green — `bun test tests/codex-host.test.ts -t "reviewer-route repository-prefixed"`: 1 passed.
7. Red — `bun test tests/native-controls.test.ts -t "contradictory Code Mode"`: mismatched submission ordinal reported complete.
   Green — `bun test tests/native-controls.test.ts -t "contradictory Code Mode"`: 1 passed.
8. Red — `bun test tests/codex-native-calls.test.ts -t "attributable control evidence"`: foreign namespace and oversized tool labels reported complete.
   Green — `bun test tests/codex-native-calls.test.ts -t "attributable control evidence"`: 2 passed.

These focused slices do not substitute for the full GitHub CI acceptance gate
on the PR's exact published commit.
