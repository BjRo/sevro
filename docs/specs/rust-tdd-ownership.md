# Rust run ownership: CLI slices

This records the live-owner and confirmed-dead recovery slices from the
[CLI/engine parity specification](rust-cli-engine-parity.md#concurrency-cancellation-and-retention)
and [ownership requirements](rust-fixtures-graders-parity.md#run-ownership-checkpoints-and-interruption).
It does not establish complete concurrency, recovery, or retention parity.

## Public seam and independent oracle

The regression invokes the real `sevro run --json` binary and its Bun adapter
bridge. One adapter invocation writes a readiness marker and waits for an
explicit release file. An equivalent second CLI invocation must return exit 70
before calling the candidate. Releasing the original run allows it to complete;
a later equivalent invocation succeeds without rewriting the prior active
record. Fixed explicit runner/project digests keep the comparison identity
stable. The adapter substitutes only the external candidate.

The unchanged TypeScript CLI was exercised first with the same case, adapter
behavior, jobs selection, and digest overrides. It returned exactly one refusal
document with `not_run/not_requested/not_assessed`, null run/evidence paths,
empty cases, `sevro.runner.error`, and the equivalent-active diagnostic. The
first and subsequent admitted invocations passed. Their active/checkpoint
records matched the documented lifecycle, and the earlier complete record's
bytes survived later admission.

The durable Rust test is
[`refuses_equivalent_live_run_until_finalization`](../../crates/sevro/tests/run_ownership.rs).
Its expected behavior also comes from
[the existing engine regression](../../tests/engine.test.ts) and
[run-owner integration tests](../../tests/run-owner.test.ts), rather than a
reimplementation of the claim algorithm in its assertions.

## Observed red and green

Observed on macOS arm64 with the repository's pinned Rust compiler. Both
commands used the same dedicated target directory outside the checkout.

Red — `cargo test --locked -p sevro --test run_ownership refuses_equivalent_live_run_until_finalization -- --exact`:
with the new test present and production unchanged, the second CLI returned 0
instead of 70 and executed the candidate. The test failed on that exit-code
assertion, not a timeout or setup error. The fixture released and reaped its
owned first process during failure cleanup.

Green — `cargo test --locked -p sevro --test run_ownership refuses_equivalent_live_run_until_finalization -- --exact`:
1 passed, 0 failed, 0 ignored. The second invocation was refused before candidate
execution; its newly allocated attempt directory was removed. Successful
finalization retained the trial checkpoint, complete active/claim records, and
run evidence. A subsequent invocation succeeded and preserved the first active
record exactly.

Additional actual CLI controls, run after green, passed in both directions:
a live Rust owner blocked an unchanged TypeScript contender, and a live
TypeScript owner blocked a Rust contender. Releasing each first invocation
allowed the next cross-language attempt to succeed. These are observed
compatibility controls, not additional red/green claims or simultaneous-admission
race coverage.

## Implemented state and bounds

The default state root remains the results root. The implementation writes:

- `owners/<evaluationDigest>.json` with `sevro.run-owner.v1`, evaluation digest,
  attempt ID, status, owner PID/hostname/start time, active-record path,
  evidence directory, run-evidence path, start timestamp, and terminal timestamp
  when finalized.
- `active/<runId>.json` with `sevro.active-run.v1`, the same ownership facts,
  run ID, checkpoint path, completed trial references, and terminal timestamp.
- `<runId>/checkpoint.json` with `sevro.run-checkpoint.v1`, run ID, and completed
  trial number/artifact-path references.
- `locks/<evaluationDigest>.json.sqlite`, using the existing `mutex` table and
  immediate SQLite transaction with an explicit 5-second busy timeout.

The database transaction covers claim/checkpoint mutation and ends before
candidate execution. PID existence alone does not prove ownership: the
hostname and `/bin/ps` process-start result must also match. Unknown owners are
preserved and refused. The recovery cohort below reclaims only a same-host
process confirmed absent or a PID whose verified start identity changed. There
is no time-based lease.

Completed trial evidence is persisted before checkpointing and successful
workspace cleanup. A checkpoint error still allows cleanup of an already
persisted passing trial, matching the observed TypeScript behavior. Failed,
cancelled, and unpersisted trial workspaces remain retained. Final run evidence precedes complete/interrupted owner
finalization. An admitted run error attempts diagnostic finalization while
preserving the original error and retained files. A result/latest publication
failure after ownership completion does not rewrite that completion.

Before admission, cleanup owns only the newly created attempt directory and
preserves pre-existing files, claims, and locks. Once the claim JSON is
published, the attempt directory remains retained even if SQLite commit fails:
SQLite rollback does not undo separate JSON replacements. Atomic JSON writes
use the existing private-file implementation. This is not a claim of one
atomic transaction across all JSON files.

## Dependencies and validation

The exact `rusqlite` 0.40.2 dependency disables default features and enables only
`bundled`; the existing `nix` dependency adds `hostname`. The resolved new
packages were `rusqlite` 0.40.2, `libsqlite3-sys` 0.38.2, `cc` 1.8.0,
`find-msvc-tools` 0.1.14, `shlex` 2.0.1, `pkg-config` 0.3.34, `vcpkg` 0.2.15,
`fallible-iterator` 0.3.0, and `fallible-streaming-iterator` 0.1.9. Existing
locked package versions were unchanged. No SQLite service or CLI is required.

The observed macOS debug build emitted `rustc-link-lib=static=sqlite3`, produced
`libsqlite3.a`, and had no SQLite dynamic-library dependency in `otool -L`.
This is local debug-build evidence, not installed-release or Linux linkage
validation. Bundled SQLite requires a C compiler during source builds. Rusqlite
and its bindings use MIT licensing; SQLite is public domain. Binary
distribution notices remain a packaging responsibility against the resolved
dependency graph. The package's `native-bundle` feature and installed-bundle
test selection were preserved.

Observed scoped checks for the first cohort:

- `cargo clippy --locked -p sevro --bin sevro --test run_ownership -- -D warnings`:
  passed.
- `cargo test --locked -p sevro --test run_ownership --test run_results --test run_storage --test run_receipts --test run_dry --test run_console --test run_adapter --test run_required_evidence --test demo --no-fail-fast`:
  68 passed, 0 failed, 0 ignored across nine integration binaries.

## Confirmed-dead recovery and finalized retries

The actual TypeScript CLI oracle held an adapter at readiness, replaced the
first attempt's checkpoint file with a directory containing a caller-owned
sentinel, released the adapter, and awaited CLI termination. That invocation
exited 70 with unchanged active claim/record and a persisted trial. Retrying the
same evaluation then exited 0. The old trial bytes and checkpoint collision
survived; the old active record and retained `run-owner.json` became interrupted.
The old passing workspace was absent before and after retry. An initial oracle
assertion incorrectly expected that workspace to survive; it was corrected to
record actual existence before proceeding, without changing TypeScript.

The reproduction and raw observations are retained outside the repository in
`sevro-rust-ownership-20261016/reproduce-recovery-oracle.py` and
`typescript-checkpoint-retry-oracle.json`. The durable Rust tests use the real
CLI, unchanged evaluation inputs across attempts, real process termination,
and actual filesystem faults. Expected stored transitions also follow
[run-owner tests](../../tests/run-owner.test.ts),
[checkpoint tests](../../tests/run-owner-checkpoints.test.ts), and
[trial cleanup](../../src/evaluation/trial.ts).

Red — `cargo test --locked -p sevro --test run_ownership retries_after_checkpoint_failure_without_discarding_prior_evidence -- --exact`:
the first CLI exited 70 as intended, but its equivalent retry returned 70
with unverifiable ownership instead of 0 because the dead owner was never reclaimed.

Green — `cargo test --locked -p sevro --test run_ownership retries_after_checkpoint_failure_without_discarding_prior_evidence -- --exact`:
1 passed. Retry succeeded with a new attempt; prior interrupted provenance,
trial bytes, and the checkpoint-directory sentinel were retained. Recovery did
not change the prior workspace's observed existence.

Red — `cargo test --locked -p sevro --test run_ownership cleans_persisted_passing_workspace_when_checkpoint_fails -- --exact`:
the independently tested passing workspace remained after checkpoint failure,
contrary to the TypeScript CLI observation.

Green — `cargo test --locked -p sevro --test run_ownership cleans_persisted_passing_workspace_when_checkpoint_fails -- --exact`:
1 passed after delaying propagation of the checkpoint error until the existing
passing-workspace cleanup completes. The saved trial and active claim survive.

Red — `cargo test --locked -p sevro --test run_ownership refuses_unknown_owner_without_replacing_evidence -- --exact`:
a null owner produced an unrecognized-record diagnostic instead of the required
unverifiable-owner diagnostic.

Green — `cargo test --locked -p sevro --test run_ownership refuses_unknown_owner_without_replacing_evidence -- --exact`:
1 passed after separating retained-claim parsing from process identity validation.
Null owners, numeric/empty process start values, foreign hosts, and zero,
negative, or fractional PIDs refuse admission without replacing claim, active,
or checkpoint bytes or starting another candidate.

Red — `cargo test --locked -p sevro --test run_ownership reclaims_changed_start_with_missing_or_null_active_record -- --exact`:
a verified different process-start identity with missing active evidence returned
70 with ENOENT instead of permitting the next attempt.

Green — `cargo test --locked -p sevro --test run_ownership reclaims_changed_start_with_missing_or_null_active_record -- --exact`:
1 passed. Missing active evidence gets TypeScript's reconstructed record; JSON
null gets its minimal interrupted representation. Prior checkpoint bytes and
opaque claim fields survive. A superseded still-running process cannot overwrite
the new claim when it eventually tries to checkpoint. An intervening launcher
attempt returned `cargo: command not found` without executing the test; the
unchanged literal command was rerun successfully and that launch failure is not
red/green evidence.

These further focused controls passed on their first invocation and are not
additional red/green claims:

- `cargo test --locked -p sevro --test run_ownership diagnostic_finalization_allows_retry_and_retains_unpersisted_workspace -- --exact`
- `cargo test --locked -p sevro --test run_ownership interrupted_finalization_allows_retry_and_retains_cancelled_workspace -- --exact`
- `cargo test --locked -p sevro --test run_ownership completed_candidate_failure_allows_retry_and_retains_failed_workspace -- --exact`
- `cargo test --locked -p sevro --test run_ownership refuses_malformed_active_evidence_without_replacing_prior_claim -- --exact`

Diagnostic, SIGINT/SIGTERM interrupted, and completed candidate-failure attempts
permit retry without rewriting their prior finalized active bytes. Failed,
unpersisted, and cancelled workspaces remain inspectable. Signal controls use
a cooperating adapter and assert exit 130/143 and retained interrupted trials.
Malformed active JSON refuses reclamation and preserves claim/active/checkpoint
bytes; the attempted preservation may already have written interrupted
`run-owner.json`, exactly as TypeScript does. Failed admission removes only its
newly allocated attempt directory. No prior checkpoint is rewritten during
reclamation, and separate JSON files still have no multi-file atomicity guarantee.

Final scoped checks for the recovery cohort:

- `cargo clippy --locked -p sevro --bin sevro --test run_ownership -- -D warnings`:
  passed.
- `cargo test --locked -p sevro --test run_ownership --test run_results --test run_storage --test run_receipts --test run_dry --test run_console --test run_adapter --test run_required_evidence --test demo --no-fail-fast`:
  76 passed, 0 failed, 0 ignored across nine integration binaries, including all
  nine ownership tests. Receipt persistence, successful cleanup, cancellation,
  failed-workspace retention, and latest-publication controls remained green.

Independent `--run-state-root`, simultaneous admission races, a SIGKILL process
control, workspace ownership expiration, concurrent trial scheduling, and all
native-host paths remain outside this cohort's verification. Compatibility for
arbitrary scalar/array active records and unusual legacy claim shapes is not
established; object, missing, null, and malformed JSON cases are covered here.
Full acceptance still belongs to exact-candidate CI.
