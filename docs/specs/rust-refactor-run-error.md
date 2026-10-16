# Rust core error refactor evidence

The internal run result now retains available error causes while preserving the
existing public diagnostics. This is a green refactor of the accepted CLI
behavior, not a new behavioral red/green slice.

## Invariant and boundary

`RunError` stores the exact displayed message separately from an optional owned
`Error + Send + Sync` cause. Ordinary I/O, Serde/JCS and schema errors use `From`
conversions. Contextual and sanitized replacements retain their causes without
appending them to the message. Borrowed schema errors become owned before being
retained. Both `Display` and `Debug` omit the cause; causes are not serialized or
automatically logged.

The migration covers `run.rs`, the new `run/error.rs`, and the affected run core
modules. The existing preparation and provenance wrappers retain explicit phase
codes. Extension preparation adapts existing extension failures without changing
the extension transport. Upstream native and adapter APIs still return strings;
this refactor cannot recover causes already flattened by those APIs.

Public message bytes, the 4,096-character diagnostic limit, exit classification,
signal handling, partial receipts, workspace retention, cleanup warnings and
result/latest publication precedence remain the invariants. Project provenance
failures remain exit 70 with and without explicit project digest overrides.
Tests, oracles, dependencies, schemas, transports and coverage policy are unchanged.

## Before and after

The baseline is checkpoint 6, captured before edits at
`/tmp/sevro-rust-core-snapshot.x3psmgs6`, with binding
`88cfe5f03999db95b9fee2c527f367bfb19bd5c2a3dc1847448960834552bbff`.
Commands ran from the Rust port worktree on macOS with the pinned Rust toolchain
and existing Bun integration prerequisites.

Before — the following literal command passed all 120 existing public CLI tests:

```sh
cargo test -p sevro --test run_options --test run_provenance --test run_receipts --test run_storage --test run_extension --test run_console --test run_results --test run_repository --locked
```

The cohort includes options and sanitized diagnostics, real Git/filesystem
provenance, failed persistence with partial evidence, publication precedence,
extension protocol/cancellation, console output, repository preparation and the
real two-minute fixture setup deadline. No new test was introduced.

After — the identical literal command passed all 120 tests after the refactor:

```sh
cargo test -p sevro --test run_options --test run_provenance --test run_receipts --test run_storage --test run_extension --test run_console --test run_results --test run_repository --locked
```

Both runs passed console (1), extension (20), options (29), provenance (18),
receipts (2), repository (41), results (5) and storage (4), with no failures,
ignored tests or filtered tests.

An intermediate compiler check identified one remaining `String` tail return in
manifest validation. Adding its explicit conversion repaired compilation; this
was a refactor integration correction, not behavioral red evidence.

## Final checks

- `cargo check -p sevro --all-targets --locked`: passed.
- `cargo fmt --all -- --check`: passed.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed.
- `bun node_modules/prettier/bin/prettier.cjs --check docs/specs/rust-refactor-run-error.md`:
  passed.
- `bun run check:docs`: passed.

Comparison with the frozen source confirmed exactly the 19 agreed product files
changed, including the new error module. The only additional file is this ledger.

Whole-candidate coverage and platform acceptance remain separate parent-owned
checks; this ledger makes no coverage or port-completion claim.
