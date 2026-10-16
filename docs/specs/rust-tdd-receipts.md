# Rust receipt bounds and partial persistence

These slices exercise actual adapter receipts through the public
`sevro run --json` command. The tests live in
[`run_receipts.rs`](../../crates/sevro/tests/run_receipts.rs) and preserve the
[result parity contract](rust-protocol-results-parity.md). Independent
TypeScript CLI baselines were captured before their Rust tests. Each later
test and implementation began only after the preceding slice was green.

## Oversized final message

The real adapter returns an 8 MiB plus one byte final message, complete usage,
and an otherwise valid two-byte `Uint8Array` artifact. The unchanged TypeScript
CLI rejects the entire receipt: exit 2, failed execution, no requested grading,
and no task assessment. Its diagnostic is `sevro.host.failed` with
`host execution did not complete`. The retained trial has unavailable output,
null raw path/hash, empty artifact references, and unavailable usage. The
actual fixture remains available for inspection. The declared exact-output
check is not run after host failure.

- Red — `cargo test -p sevro --test run_receipts oversized_final_message_discards_the_unaccepted_receipt --locked -- --exact`:
  the exit category was correct, but Rust retained populated usage from the
  rejected receipt instead of the baseline's null usage. The same test also
  asserts that neither the raw message nor the artifact is written.
- Green — `cargo test -p sevro --test run_receipts oversized_final_message_discards_the_unaccepted_receipt --locked -- --exact`:
  one test passed after the byte bound moved before acceptance of receipt
  fields or artifact persistence. A shell environment typo prevented an
  intermediate command from finding Cargo; that tool failure is not claimed
  as behavioral evidence.

The size guard remains at the shared host boundary. Adapter decoding proves
field types and binary encoding, but it does not establish the final-message
size limit. Native receipts also enter this boundary. Artifact identity,
duplicate, and size defenses remain in place; no guard was replaced by a
panic or removed solely to change coverage.

## Actual raw-evidence write conflict

The second adapter finds its already allocated run directory and creates a
directory at `trial-1-raw.txt` before returning `ready`, usage, and an actual
`example.trace` artifact with bytes `A\n`. This is a deterministic filesystem
conflict, not a forced race or a substituted storage implementation.

The unchanged TypeScript CLI returns 70 with `sevro.runner.error` and
`trial persistence failed; fixture retained at` followed by the actual
workspace path. Its CLI error has null run/evidence paths and no cases. The
original workspace and the earlier retained host artifact remain intact.
There is no completed trial, run, run-local result, or latest publication.

- Red — `cargo test -p sevro --test run_receipts raw_evidence_write_failure_retains_actual_partial_evidence_and_workspace --locked -- --exact`:
  Rust returned the expected exit category but exposed a file-exists error
  instead of the diagnostic locating the retained workspace.
- Green — `cargo test -p sevro --test run_receipts raw_evidence_write_failure_retains_actual_partial_evidence_and_workspace --locked -- --exact`:
  one test passed after mapping this raw-evidence write failure to the existing
  persistence diagnostic. The assertions verify actual fixture and artifact
  bytes and absence of completed publications.

The test fixture cleans its own retained workspace after assertions. The
product neither fabricates successful records nor removes partial evidence.
Other persistence operations remain fallible; SQLite ownership, checkpoints,
recovery, and general host observations remain separate port work.

The external baseline script is `/tmp/sevro-receipt-persistence-baseline.py`;
its original commands, stdout, stderr, and summarized evidence are retained in
the `sevro-receipt-oversized-baseline-*` and
`sevro-receipt-write-conflict-baseline-*` temporary directories. Expected states
and bytes are literal in the durable tests.

Final validation for the original oversized-message and raw-write slices passed:

- `cargo test -p sevro --test run_receipts --test run_storage --test run_results --test run_required_evidence --test run_adapter --locked`:
  all 35 tests passed, including the maximum accepted adapter payload and both
  new receipt cases.
- `cargo clippy --workspace --all-targets --locked -- -D warnings` passed.
- Scoped Rust formatting and `bun run check:docs` passed.

The separately owned
[result precedence slice](rust-tdd-results.md) verifies that a later
result/latest publication failure preserves an existing nonzero run outcome.
That behavior is distinct from the interrupted trial persistence above.
Candidate-wide coverage, independent review, and hosted platform gates remain
the coordinator's acceptance work.

## Host-artifact write conflict

The real adapter creates a directory at its second artifact's destination,
`trial-1-host-example.blocked.bin`, before returning two valid `Uint8Array`
artifacts, `ready`, and known usage. The unchanged TypeScript CLI retains the
first artifact's literal bytes `A\n`, keeps the actual workspace and the
blocking directory, and returns 70. The diagnostic is
`trial persistence failed; fixture retained at` followed by that actual
workspace. No raw response, trial, run, run-local result, or latest result is
published. This is a real filesystem conflict before grading, distinct from
the earlier raw-response write failure.

- Red — `cargo test -p sevro --test run_receipts host_artifact_write_failure_keeps_earlier_bytes_and_names_retained_workspace --locked -- --exact`:
  Rust returned 70 but exposed the file-exists error rather than locating the
  retained workspace.
- Green — `cargo test -p sevro --test run_receipts host_artifact_write_failure_keeps_earlier_bytes_and_names_retained_workspace --locked -- --exact`:
  one test passed after host-artifact and raw-response writes shared the
  workspace-locating persistence diagnostic. The internal error cause is
  preserved; actual earlier artifact bytes remain intact.

## Artifact ID colliding with a declared check

A separate real adapter returns `ready`, known complete usage, and an artifact
whose ID is the declared exact-output check's `example.trace`. The unchanged
TypeScript CLI rejects the receipt with exit 2, failed execution, no requested
grading, no assessment, and the generic `sevro.host.failed` diagnostic.
Retained trial evidence has unavailable output, null raw path/hash, empty
artifact references, and null incomplete usage. The actual failed workspace
and valid trial/run/result/latest documents remain available. A matching final
response cannot override the collision or turn the check into a pass.

- Red — `cargo test -p sevro --test run_receipts artifact_check_id_collision_discards_the_unaccepted_receipt --locked -- --exact`:
  Rust accepted the colliding artifact and returned 0 instead of the baseline's 2.
- Green — `cargo test -p sevro --test run_receipts artifact_check_id_collision_discards_the_unaccepted_receipt --locked -- --exact`:
  one test passed after declared check IDs joined the reserved artifact IDs
  and artifact validation moved before acceptance of receipt fields. The
  rejected receipt contributes no usage, response, or artifact bytes. Cargo
  waited for shared package/build locks before this successful execution;
  those waits were not behavioral failures.

Both new TypeScript baseline commands, output streams, and retained-file
observations live under `sevro-records-public-baselines-bxuf4fse`, in the
`artifact-write` and `reserved-check-id` directories. The external capture
script is `/tmp/sevro-records-public-baselines.py`.

For these two newer artifact cases, only the exact focused green commands
above have been observed after the changes. Affected full regressions, strict
Clippy, workspace formatting, and documentation checks remain pending the
coordinator's frozen-candidate gate. The earlier validation results apply only
to the original two slices and do not validate these newer changes.

## Deferred non-finite usage observation

The same read-only capture separately observed that `costUsd: Number.NaN`
from a real adapter returns 70 with `invalid Sevro retained evidence` in the
unchanged TypeScript CLI. Its raw response and trial document already exist;
the serialized trial cost is null, the passed workspace has been cleaned,
and no run/result/latest document is published. A JSON bridge can lose the
distinction between non-finite cost and an honestly unknown null cost. This
captured `nan-cost` case remains deferred: these slices add no test, transport
change, or product claim for that behavior.
