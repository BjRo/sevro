# Rust workspace cleanup and result publication

These public CLI slices preserve the existing cleanup and retention behavior
described by the [runtime parity specification](rust-runtime-hosts-parity.md)
and [result parity specification](rust-protocol-results-parity.md).
The durable integration tests are in
[`run_storage.rs`](../../crates/sevro/tests/run_storage.rs).

## Permission-locked candidate contents

The independent TypeScript oracle is
`tests/cli/trial-retention.test.ts`, including its child, unreadable root, and
read-only root variants. Before adding the Rust test, the unchanged TypeScript
CLI executed an adapter that creates a candidate-owned directory, links an
external directory into it, and removes its own directory permissions.
The external directory and file had modes 0500 and 0400 and recognizable bytes.
The observed result was exit 0, completed execution, no requested grading,
no task assessment, and a removed candidate workspace. The external modes and
bytes remained unchanged.

The first durable test used a child directory with mode 0000:

- Red: `cargo test -p sevro --test run_storage removes_permission_locked_workspace_without_changing_external_symlink_target --locked -- --exact`
  compiled and reached the CLI. Rust returned 70 because workspace removal
  failed with permission denied; the oracle required 0.
- Green: the identical command passed after cleanup restored owner access to
  actual directories and retried removal. The traversal does not follow
  directory symlinks.

Separate TypeScript executions confirmed the root variants with modes 0000
and 0500. Their Rust characterization,
`removes_unreadable_and_read_only_workspace_roots_without_following_symlinks`,
passed on its first execution; it is not a claimed red/green slice. All variants
assert real workspace removal, retained result/evidence consistency, and
unchanged external bytes and modes.

## Failure to publish the latest result

A real filesystem conflict places a directory at `results/latest.json` before
the run. An actual adapter returns the complete message `ready`. The unchanged
TypeScript CLI returned 70 with diagnostic `sevro.runner.error` and the message
`CLI result/latest could not be retained; check --results-root permissions`.
It retained the completed run, trial, raw message, and run-local result before
the failed final publication. The CLI error itself has null run/evidence paths
and no cases. The existing directory survives, and temporary JSON files do not.

- Red: `cargo test -p sevro --test run_storage latest_publication_failure_keeps_completed_evidence_and_removes_temporary_files --locked -- --exact`
  observed the correct exit category but an operating-system-specific rename
  error instead of the existing actionable diagnostic.
- Green: the identical command passed after final result/latest publication
  errors were mapped to that diagnostic. The assertions also verify actual
  retained bytes, matching trial/run snapshots, and temporary-file cleanup.

These tests use genuine files, permissions, adapters, and CLI processes. They
do not fabricate persistence failures or replace filesystem operations. The
fixtures clean their own retained workspaces after assertions. SQLite ownership,
leases, crash recovery, and durable workspace expiry remain separate required
lifecycle work; these slices do not claim those mechanisms exist.

## Completed workspace replaced with a file

An independently executed TypeScript adapter removed its own workspace
directory and wrote a regular file at the same path before returning the
complete message `ready`. The TypeScript CLI kept exit 0, completed execution,
no requested grading, and no task assessment. It retained consistent
trial/run/result/latest records and raw output. The replacement file kept its
original `candidate replacement file\n` bytes. Standard error warned
`fixture cleanup failed; retained at` followed by that actual path.

- Red — `cargo test -p sevro --test run_storage cleanup_failure_preserves_completed_result_and_replacement_file --locked -- --exact`:
  Rust returned 70 with `Not a directory` when cleanup encountered the actual
  replacement file, instead of preserving the completed evaluation.
- Green — `cargo test -p sevro --test run_storage cleanup_failure_preserves_completed_result_and_replacement_file --locked -- --exact`:
  one test passed after completed-workspace cleanup failures became an
  actionable retention warning. The test verifies successful classification,
  unchanged replacement bytes, original raw output, and matching trial, run,
  run-local result, and latest records.

Only the completed-workspace cleanup call handles errors this way. Evidence
serialization and publication remain fallible, as the latest-publication
failure test continues to require. The test fixture removes its own retained
replacement file after the public assertions; it does not mock cleanup or
inject a filesystem error.

Before the replacement-file slice, the original three-test storage suite
passed, as did the related dry-run, grader, result-aggregation, and storage
suites together: 14 tests through their public executable seams.

After that slice, `cargo test -p sevro --test run_storage --test run_results --test run_required_evidence --locked`
passed all 13 tests, including four storage cases. Scoped Rust formatting,
`cargo clippy --workspace --all-targets --locked -- -D warnings`, and
`bun run check:docs` passed. Platform-wide coverage and hosted macOS/Ubuntu
acceptance remain the coordinator's candidate gate, not a claim made by these
local slice results.

## Storage failure recovery hint

A regular file at the selected results root already produced exit 70 and the
correct unassessed CLI result, but Rust printed the invocation-repair hint.
The independent direct-run oracle is
[`tests/cli/diagnostics.test.ts`](../../tests/cli/diagnostics.test.ts), whose
storage-collision cases require a writable-results hint in both output modes.
[`src/cli/presentation.ts`](../../src/cli/presentation.ts) supplies its exact
text. An actual unchanged TypeScript demo invocation also returned that hint;
its observation is retained at
`/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-demo-preparation-baseline-RnP5ip/observation.json`.
The corresponding Rust observation under `sevro-demo-preparation-baseline-Ls8Sih`
showed the supported-options hint instead. These are prior observed baselines,
not new executions claimed by this slice.

The new direct `run --json` test uses a real results-root file and the existing
public adapter fixture. It verifies exit 70, the complete unassessed envelope,
one JSON document, the selected path in the diagnostic, unchanged caller-owned
file bytes, and no candidate execution. It requires this exact final stderr
line, independently of the operating system's error wording:

```text
Check the reported path and ensure --results-root and --run-state-root are writable directories, then retry.
```

- Red — `cargo test -p sevro --test run_storage results_file_collision_prints_runner_storage_hint --locked -- --exact`:
  exited 101 with one failed test. The envelope, path, caller-file and
  no-execution assertions passed; the final stderr assertion failed because
  Rust printed the supported-options hint.
- Green — `cargo test -p sevro --test run_storage results_file_collision_prints_runner_storage_hint --locked -- --exact`:
  exited 0 with one passing test after only the shared failure printer's
  exit-70 hint selection changed.

The code-64 hint retains its existing wording. Diagnostic bytes and truncation,
error classification, shutdown ordering, completed outcomes and signal
precedence are unchanged.

Follow-up checks passed:

- `cargo test -p sevro --test run_storage --locked`: all five tests passed.
- `cargo test -p sevro --test run_options malformed_cli_arguments_keep_configuration_failure_diagnostics --locked -- --exact`:
  one test passed, covering eight invalid argument selections with exit 64.
- `rustfmt --edition 2024 --check --config skip_children=true crates/sevro/src/run.rs crates/sevro/tests/run_storage.rs`:
  passed after applying the formatter's two assertion-wrap changes in the new
  test. The earlier formatting failure was not behavioral red evidence.
- `cargo clippy -p sevro --bin sevro --test run_storage --test run_options --locked -- -D warnings`:
  passed.
- `bun node_modules/prettier/bin/prettier.cjs --check docs/specs/rust-tdd-storage.md`:
  passed.
- `bun run check:docs`: passed.

This slice changes only `run.rs`, `tests/run_storage.rs`, and this ledger.
Broad acceptance and platform coverage remain coordinator-owned checks.
