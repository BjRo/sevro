# Template and batch inspection for issue 85

On 2026-10-15, the implementation for [issue #85](https://github.com/BjRo/sevro/issues/85)
replayed the two original Codex native transcript bundles through the changed
Sevro observers and Darrow's checkpoint `67f4fcdb` extension. Bundle and decoded
source SHA-256 values matched the issue before replay. Raw bundles and output
remain private and outside Git.

| Original case                     | Exec submissions | Complete receipts after replay | Regraded no-agent assertion |
| --------------------------------- | ---------------- | ------------------------------ | --------------------------- |
| goal-placement-direct-same-route  | 11               | 11                             | passed                      |
| goal-placement-coupled-sequential | 10               | 10                             | passed                      |

The five exact [retained program fixtures](../../tests/fixtures/code-mode-85/README.md)
now preserve these native ordinals and ordered submission-local labels:

- Direct 45: three `exec_command` calls.
- Direct 69 and 77: `apply_patch`, then `exec_command`.
- Coupled 30: three `exec_command` calls.
- Coupled 68: two `exec_command` calls.

Regrading replaced only the native-call and portable native-control observations
with newly inspected observations and invoked the original case's extension
checks. Both `darrow.evals.transcript.1` results changed from unavailable to
passed. These are artifact rechecks, not new candidate runs or rewritten
historical task verdicts. Deterministic consumer coverage separately confirms
that a submitted `spawn_agent` fails the no-agent assertion even when the
accepted-agent count is zero, and partial receipts remain unavailable.

## Observed test-first slices

1. Red — `bun test tests/codex-native-calls.test.ts -t 'retained direct ordinal 45'`: the template-command receipt was partial.
   Green — `bun test tests/codex-native-calls.test.ts -t 'retained direct ordinal 45'`: 1 passed, with three bound call labels.
2. Red — `bun test tests/codex-native-calls.test.ts -t 'retained coupled ordinal'`: both destructured batch receipts were partial.
   Green — `bun test tests/codex-native-calls.test.ts -t 'retained coupled ordinal'`: 2 passed, with three and two bound call labels respectively.

Additional regressions preserve submitted spawns inside interpolated and
concatenated output, reject ambiguous bindings and composition, and keep
private source bytes out of observations. The focused native-call/control
suite passed 94 tests. These checks do not replace the full GitHub CI gate
on the PR's exact published commit.

## Fresh native trials

Fresh trials use Darrow checkpoint `67f4fcdb`, native Codex 0.162.1 app-server,
candidate and semantic grader `gpt-6-luna/medium`, passive ownership, N=1,
jobs=1, threshold=1, and a 1,200,000 ms timeout with retained diagnostics.
They explicitly select the changed Sevro source worktree through
`SEVRO_CHECKOUT`; they are development evidence, not published-package trials.

The direct trial, run `510f99df-882f-48fe-b893-d4b6fba8864d`, completed with
9/10 checks passing and the no-agent assertion unavailable. Its new submission
29 maps a callback that invokes tools over a command array; submission 74 uses
an output callback with a conditional expression. Both forms remain outside
the [bounded inspection contract](../native-controls.md) and correctly retain
partial receipts. The five original programs no longer cause that limitation.

The coupled trial, run `7f9f5d8a-641e-4744-a986-05298100541c`, completed with
10/11 checks passing and the no-agent assertion unavailable. Submissions 29,
45, and 68 each use a `for ... of` output loop with a conditional expression
and `String(...)` conversion. That output body is also outside the bounded
subset and remains partial. Neither fresh run is a passing placement trial;
their unavailable verdicts are preserved rather than treating zero accepted
agents as proof of absence.
