# Typed preparation handoffs

This records two behavior-preserving green refactors of the Rust preparation
path on 2026-10-16. Existing public CLI regressions passed before each change
and passed again with the identical commands afterward. No new behavior, tests,
or behavioral red is claimed.

## Boundary and preserved behavior

[`Session::exchange`](../../crates/sevro/src/extension.rs) validates the public
[extension schema](../../schemas/extension-v1.schema.json), correlates the
response, and verifies declared extension sources before returning the
preparation result. The private `Preparation` decoder in
[`extension_context.rs`](../../crates/sevro/src/run/extension_context.rs) now
decodes artifact and setup shapes once. Its failure produces phase 70 with the
bounded message `could not decode validated extension preparation`, retaining
the Serde error as the `RunError` cause. Invalid external responses still fail
the original schema boundary with phase 70 and `invalid extension response`.
The new error covers internal schema/type drift; no artificial private-input
test was added to force that condition.

`ArtifactDeclaration` has private fields and visibility limited to `crate::run`.
`Preparation`, `ExtensionContext`, and `fixtures::prepare` carry the typed list
instead of `Vec<Value>`. `artifacts::prepare` clones that list for source
resolution instead of deserializing every item again. The type carries the
decoded field shapes, not a claim that filesystem paths or contents are safe.
All source references still resolve before inline artifact validation. Unique
IDs, canonical base64, declared digests, per-artifact and aggregate size limits,
path collisions, canonical source containment, bounded reads and post-read size
checks, Git restrictions, mount checks, and fallible file-URL conversion remain.
Artifact identity and retained evidence serialization are unchanged.

`FixtureSetupInput` is a separate Deserialize-only shape with the existing
closed fields and default empty environment. `FixtureSetup::prepare` consumes
that input and retains every command and environment guard, including command
length and nonempty arguments. No semantic validation moved into Deserialize.
The order remains schema/correlation, private shape decoding, unsupported
instrumentation, setup semantic validation, negotiated setup capability, and
later Git-fixture validation. Prepared setup serialization and identity remain
unchanged. The existing [setup contract](../extension-protocol-v1.md) still
governs execution, environment, cancellation, and the two-minute deadline.

Existing schema-shape coverage is retained in
[`extension-boundaries.test.ts`](../../tests/schema/extension-boundaries.test.ts),
particularly `rich extension documents retain every required scalar and
container` and `rich extension documents enforce declared choices, patterns,
uniqueness and closed fields`. Its rich documents include both inline and
source-reference artifacts and setup. The existing Rust preparation refusal
test below exercises schema and correlation rejection at the real CLI seam.
No duplicate regressions were introduced.

## Artifact handoff: observed green before and after

Commands ran from the worktree root with the pinned Rust 1.99 toolchain and the
existing feasibility toolchain's `CARGO_HOME`, `RUSTUP_HOME`, and `PATH`.

| Literal command                                                  | Before    | After     |
| ---------------------------------------------------------------- | --------- | --------- |
| `cargo test -p sevro --test run_repository artifacts:: --locked` | 12 passed | 12 passed |
| `cargo test -p sevro --test run_extension --locked`              | 21 passed | 21 passed |

The artifact handoff changed only `extension_context.rs`, `fixtures.rs`, and
`fixtures/artifacts.rs`. Both commands completed successfully before the setup
handoff began.

## Setup handoff: observed green before and after

| Literal command                                                                                                                      | Before   | After    |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------- |
| `cargo test -p sevro --test run_repository setup::rejects_invalid_setup_declarations_before_host_execution --locked -- --exact`      | 1 passed | 1 passed |
| `cargo test -p sevro --test run_repository setup::preserves_literal_setup_environment_values --locked -- --exact`                    | 1 passed | 1 passed |
| `cargo test -p sevro --test run_repository runs_negotiated_setup_in_the_materialized_repository --locked -- --exact`                 | 1 passed | 1 passed |
| `cargo test -p sevro --test run_extension refuses_uncorrelated_or_invalid_preparation_before_retaining_evidence --locked -- --exact` | 1 passed | 1 passed |

The setup handoff changed only `extension_context.rs`, the setup re-export in
`fixtures.rs`, and `fixtures/setup.rs`. A read-only check by the setup proposal's
owner confirmed the retained field defaults, semantic guards, serialization,
and validation order. This is scoped inspection, not full acceptance review.

## Final checks

- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/src/run/extension_context.rs crates/sevro/src/run/fixtures.rs crates/sevro/src/run/fixtures/artifacts.rs crates/sevro/src/run/fixtures/setup.rs` passed.
- `cargo clippy --workspace --all-targets --locked -- -D warnings` passed.
- `bun run check:docs` passed initially and after adding the diagnostic rerun record.
- `cargo test -p sevro --test run_extension --locked` passed all 21 tests in
  163.48 seconds.
- `cargo test -p sevro --test run_repository --locked` finished with 48 passed
  and three failed in 272.07 seconds. The timeout test failed at
  `setup.rs:264` with `setup and descendant did not become ready within ten
seconds`; the cancellation test failed at `setup.rs:150` with `setup fixture
did not start`. Both failed before observing their setup readiness records,
  so neither result establishes the tested timeout or cancellation behavior.
  The overlay boundary test failed at `overlay.rs:327` for `invalid fixture
path: a/./b`: expected exit 64, observed 70. That assertion did not print the
  returned diagnostic.

Other agents' test/build processes were observed during the final suite runs.
Concurrency is execution context, not an established explanation for these
failures. The four product files were held without further edits or retries
while the coordinator collected the failures and arranged a separate test slot.

After all prior runtime jobs drained, the coordinator assigned one runtime slot.
These three existing tests ran unchanged, separately and in this order:

| Literal command                                                                                                                        | Result                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `cargo test -p sevro --test run_repository overlay::rejects_unsafe_colliding_or_excessive_overlay_paths --locked -- --exact`           | 1 passed in 2.62 seconds   |
| `cargo test -p sevro --test run_repository setup::cancels_setup_descendants_and_retains_the_admitted_trial --locked -- --exact`        | 1 passed in 5.46 seconds   |
| `cargo test -p sevro --test run_repository setup::times_out_setup_after_two_minutes_and_terminates_its_descendant --locked -- --exact` | 1 passed in 120.67 seconds |

No product or test edits occurred between the failed full-suite run and these
diagnostics within this refactor's ownership. The successful timeout test
observed ready setup processes, exercised the real two-minute deadline and
verified exit 70, process termination, private HOME removal, and retained
workspace bytes. The isolated passes do not establish the cause of the earlier
failures or replace a clean full-candidate acceptance run. The original failure
output tail and rerun output chunks are retained outside the checkout under
`/Users/bjro/.codex/artifacts/sevro-rust-preparation-refactor-20261016/`.
