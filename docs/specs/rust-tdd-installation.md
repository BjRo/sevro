# Rust installed-bundle TDD evidence

The public seam is an installed Rust executable running the shipped graded case
with its shipped adapter, outside the checkout. The user selected installed
binary and shipped asset bytes for native build identity. The explicit opt-in
layout and digest follow the [identity contract](../identity-v1.md). This slice
does not change npm installation or claim full installed-workflow parity.

The fixture installs the actual `native-bundle` binary at `bin/sevro`, copies the
mandatory package assets, writes the declared manifest, and invokes `run --json`
with `examples/basic/graded.json` and `examples/basic/host.ts`. It supplies no
runner digest override. The temporary consumer has neither source Git metadata
nor a test checkout. Python independently enumerates and hashes the installed
bytes and canonical native envelope; it does not import Rust helpers or derive
expectations from the manifest inventory. Retained v1 evidence must agree with
the CLI result and independently computed runner digest.

## Actual red and identical green

The additive Cargo feature and required-feature test target were harness
preparation. Their creation or compiler recognition is not red evidence.

```sh
cargo test --locked -p sevro --features native-bundle --test installed_bundle installed_bundle_runs_packaged_case_with_bound_assets -- --exact
```

The first execution compiled and ran the packaged case successfully, but failed
the retained runner comparison: the actual standalone digest was
`754b4f655238f0816891576e72b15ec8c1d7458edb1502270692b405930b54b0`, while the
independent bundle receipt expected
`d068f655d4e9201b290b8263bcc038e65d7267f16ae13d4ce973cafe6f448e2e`. Package
name, version, execution, grading, and task verdict already matched. The command
exited 101. This was the missing bundle identity behavior.

After adding executable-relative bundle validation and the bound manifest/assets
digest, the identical command exited 0 with one test passed. Product code retains
the default standalone profile and explicit digest override precedence.

## Additional public controls

Each command below passed on its first execution and required no additional
product change. These are initial-green controls; no red is claimed.

- `cargo test --locked -p sevro --features native-bundle --test installed_bundle relocating_a_complete_bundle_preserves_its_build_identity -- --exact`:
  moving the complete bundle preserves the retained runner identity and matches
  the independent receipt at the new location.
- `cargo test --locked -p sevro --features native-bundle --test installed_bundle changing_a_shipped_asset_changes_the_installed_build_identity -- --exact`:
  changing the copied README changes the digest and matches the new receipt.
- `cargo test --locked -p sevro --features native-bundle --test installed_bundle missing_bundle_manifest_or_asset_refuses_without_replacing_latest -- --exact`:
  withholding the manifest or required report schema returns 70 without successful
  evidence, preserves the prior latest result, and leaves the withheld file intact.
- `cargo test --locked -p sevro --features native-bundle --test installed_bundle copied_out_bundle_executable_does_not_fall_back_to_standalone_identity -- --exact`:
  a detached `bin/sevro` refuses despite the original valid bundle remaining nearby.
- `cargo test --locked -p sevro --features native-bundle --test installed_bundle explicit_runner_digest_overrides_automatic_bundle_identity -- --exact`:
  an explicit digest still permits the packaged run when the manifest is absent.
- `cargo test --locked -p sevro --features native-bundle --test installed_bundle unsafe_manifest_paths_refuse_without_changing_outside_files -- --exact`:
  traversal, absolute paths, and backslashes refuse without modifying the owned
  outside-file sentinel or creating successful evidence.
- `cargo test --locked -p sevro --features native-bundle --test installed_bundle symlinked_or_non_file_assets_refuse_without_changing_the_referent -- --exact`:
  a linked README and a directory replacing it both refuse; the owned referent
  remains byte-for-byte unchanged.

Executable fixtures use a waited `/bin/cp` child so another test's spawn cannot
inherit a writable executable descriptor. Tests retain ordinary concurrency;
there are no retries, ignored tests, or serialization workarounds.

## Scoped validation and coverage controls

After the green slices and a small cleanup removing an invariant unwrap:

- `cargo test --locked -p sevro --features native-bundle --test installed_bundle`:
  eight passed, zero ignored.
- `cargo test --locked -p sevro --test run_provenance`: eighteen passed, zero
  ignored, including the existing standalone installed-binary receipt test.
- `cargo clippy --locked -p sevro --features native-bundle --test installed_bundle -- -D warnings`:
  passed.
- `rustfmt --edition 2024 --check crates/sevro/src/run/provenance.rs crates/sevro/src/run/provenance/bundle.rs crates/sevro/tests/installed_bundle.rs`:
  passed.
- `bunx --no-install prettier --check docs/identity-v1.md docs/specs/rust-tdd-installation.md docs/specs/rust-quality.md .github/workflows/rust.yml`:
  passed.
- `bun run check:docs`: passed.

Local commands ran from the worktree root on macOS arm64 with Rust 1.99.0,
through `lean-ctx -c`. `RUSTUP_HOME` and `CARGO_HOME` selected the toolchain under
`/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain`.
The dedicated target and control artifacts are under
`/Users/bjro/.codex/artifacts/sevro-native-bundle-20261016.cqkieS`.

Before repository implementation, an isolated real-compiler experiment proved
the two-profile mapping strategy on stable and pinned nightly compilers. Its
retained root is
`/Users/bjro/.codex/artifacts/sevro-bundle-coverage-control-20261016.rSFWy1`;
`binding.json` has SHA-256
`4c133cfccfcab000473b41d316e5751e34828043d6681cb2036ab7ad7a68d4f5`.
That experiment is tooling evidence, not product red evidence or port acceptance.

The maintained [feature control](../../scripts/rust/test-feature-coverage.py)
then ran with these commands, each using a new external output directory:

```sh
python3 scripts/rust/test-feature-coverage.py --toolchain 1.99.0 --output-dir /Users/bjro/.codex/artifacts/sevro-native-bundle-20261016.cqkieS/stable-control-verified
python3 scripts/rust/test-feature-coverage.py --toolchain nightly-2026-10-15 --branch --output-dir /Users/bjro/.codex/artifacts/sevro-native-bundle-20261016.cqkieS/nightly-control-verified
```

Both passed. Actual compiler line counters progressed from 9/10 to
14/15 to 15/15; nightly supported branch outcomes progressed from 1/2 to 3/4 to
4/4. Partial reports failed the unchanged gates. JSON, LCOV, HTML, and threshold
enforcement used identical executable object sets. Missing raw cohorts and
saved mappings failed the separate orchestration guard. Sources, command
statuses, logs, raw profiles, mappings, and reports remain retained.
The public collector also rejected an actual failing default test with complete
source counters, while still executing the bundle cohort and retaining its
diagnostic report. Thus successful coverage cannot replace successful tests.

The [Rust quality contract](rust-quality.md) requires the full default suite,
the separate bundle suite, both compiler profiles, and unchanged 95% gates on
both CI platforms. Local fixture controls do not establish production coverage
or Ubuntu acceptance. The coordinator owns exact-candidate CI and remaining
installed-workflow parity.

## Installed prompt-only execution and combined reporting

Two further bounded controls use the existing installed-package assertions in
[`verify-package-install.ts`](../../scripts/verify-package-install.ts): a
prompt-only run must not claim task success, and reporting real graded plus
prompt-only results must retain their assessment and measurement distinctions.
Each Rust control followed an actual unchanged TypeScript public CLI capture.
The captures invoked checkout `src/cli.ts` with the packaged basic examples from
a separate temporary project; they establish the observed oracle outcomes, not
fresh npm-install acceptance. No package, runtime, workflow, or dependency change
was made for these controls.

The external capture script, literal CLI argument receipts, stdout/stderr, and
retained run evidence are under
`/Users/bjro/.codex/artifacts/sevro-native-bundle-20261016.cqkieS/workflow-oracle`.
Commands ran in this order:

```sh
python3 /Users/bjro/.codex/artifacts/sevro-native-bundle-20261016.cqkieS/workflow-oracle/capture.py prompt-only
cargo test --locked -p sevro --features native-bundle --test installed_bundle installed_bundle_runs_prompt_only_without_claiming_task_success -- --exact
python3 /Users/bjro/.codex/artifacts/sevro-native-bundle-20261016.cqkieS/workflow-oracle/capture.py report
cargo test --locked -p sevro --features native-bundle --test installed_bundle installed_bundle_reports_real_graded_and_prompt_only_results -- --exact
```

The TypeScript prompt-only capture exited 0 with completed execution,
`not_requested` grading, `not_assessed`, one retained trial, and zero checks.
The matching Rust control passed on its first execution and also verified the
installed bundle's independently computed build identity in retained evidence.

Before the second Rust control, TypeScript executed the real graded case and
reported its result together with the earlier real prompt-only result. The
report exited 0 with `sevro.report.v1`, two rows, one passed case and one
unassessed case, numeric candidate durations, and null costs. The matching Rust
control passed on its first execution, preserved both actual result files, and
retained the bundle runner digest in both report rows.

Both are initial-green acceptance controls; no behavioral red or product fix is
claimed. The fixture still copies executables through a waited child, runs from
outside the checkout, and binds the complete installed asset inventory. The
initializer-to-run workflow is recorded separately below.

Final scoped validation passed: `cargo test --locked -p sevro --features
native-bundle --test installed_bundle` reported ten passed and zero ignored;
`cargo clippy --locked -p sevro --features native-bundle --test installed_bundle
-- -D warnings`, `rustfmt --edition 2024 --check
crates/sevro/tests/installed_bundle.rs`, `bunx --no-install prettier --check
docs/specs/rust-tdd-installation.md`, and `bun run check:docs` all exited 0.

## Installed response template lifecycle

The next bounded control follows `assessedTemplate` in
[`documentation-workflow.ts`](../../scripts/documentation-workflow.ts): initialize
the response template, execute its generated `run.json` in pass, fail, and dry
modes, then report the latest result. A fresh unchanged TypeScript public CLI
capture ran before the Rust test was added:

```sh
python3 /Users/bjro/.codex/artifacts/sevro-native-bundle-20261016.cqkieS/response-oracle/capture.py
bun /Users/bjro/.codex/artifacts/sevro-native-bundle-20261016.cqkieS/response-oracle/validate.ts
cargo test --locked -p sevro --features native-bundle --test installed_bundle installed_bundle_response_template_preserves_pass_fail_dry_and_latest -- --exact
```

The successful TypeScript capture is retained under `response-oracle/observed-capture`
within that external artifact root, with literal arguments, environment, exit
codes, stdout/stderr, generated files, and evidence. TypeScript exited 0 for
initialization, 0 with `passed`, 1 with `failed`, and 0 with `not_assessed` for the
dry run. The latest report selected the dry run with null candidate duration.
All seven result, evidence, and report documents passed the TypeScript public
schema assertions. The capture uses the source CLI from a separate consumer
directory; it is not fresh npm-install acceptance.

The Rust command passed on its first execution: one passed, zero ignored. This
is an initial-green acceptance control, with no behavioral red or product fix.
It invokes the copied installed binary for both initialization and subsequent
commands, uses the generated manifest's relative case and adapter paths, and
supplies no identity override. It validates documents against the installed
schemas, checks the independently computed bundle digest, and verifies retained
evidence and each latest-result update. The report leaves the latest file,
generated manifest, and adapter unchanged.

Cleanup assertions follow the observed contract: successful and dry workspaces
are removed, while the failed-task workspace remains available for diagnosis.
The test removes that owned failed workspace after checking it. Two preliminary
external capture assertions were corrected for the observation's array-valued
metadata and intentional failure retention before the Rust test was written;
those fixture mistakes are not product red evidence.

Final scoped validation passed: `cargo test --locked -p sevro --features
native-bundle --test installed_bundle` reported eleven passed and zero ignored;
`cargo clippy --locked -p sevro --features native-bundle --test installed_bundle
-- -D warnings`, `rustfmt --edition 2024 --check
crates/sevro/tests/installed_bundle.rs`, `bunx --no-install prettier --check
docs/specs/rust-tdd-installation.md`, and `bun run check:docs` exited 0.
