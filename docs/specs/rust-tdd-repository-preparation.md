# Repository preparation mutation parity

This ledger records two public CLI cases in which a trusted extension changes
its declared source repository during `prepare`. The candidate must retain the
repository revision resolved before that operation and refuse the later clone
when the repository no longer matches. These cases do not change generated
fixtures, source-map URL rules, or repository ownership/retention policy.

## Contract and independent oracles

The TypeScript preparation order is explicit in
[`prepareEvaluationEnvironment`](../../src/evaluation/plan.ts): resolve the
declared repository, then invoke extension preparation. The
[`cloneRepositorySource`](../../src/fixtures/repository.ts) revalidation checks
the source before and after cloning. The existing test
`repository cloning refuses a source revision that changed after resolution`
in [repository-snapshots.test.ts](../../tests/fixtures/repository-snapshots.test.ts)
asserts refusal before any clone contents are written.

The engine [reserves and retains the workspace](../../src/evaluation/resources.ts)
before calling [fixture creation](../../src/fixtures/create.ts). A failure using
an engine reservation retains that workspace. The
[CLI failure mapping](../../src/cli/presentation.ts) classifies the later
ordinary Git/snapshot failure as exit 70, rather than an invocation refusal.

Actual unchanged TypeScript CLI captures are retained outside the checkout in
`/Users/bjro/.codex/artifacts/sevro-repository-prepare-20261016/`. Each scenario
directory contains the real source repository, extension program and command
file, exact argv, stdout/stderr, source state, and `summary.json`. The capture
uses the public `run --json --dry --host codex --extension-command-file ...`
route, real Git and Node subprocesses, and an owned temporary directory.
No host is invoked. The TypeScript result directory contains diagnostic owner
and checkpoint records; it has no completed `run.json`, `result.json`, trial
record, or `latest.json`. It is not described as an absent results directory.

The Cargo commands below use the pinned toolchain and the dedicated
`CARGO_TARGET_DIR=/Users/bjro/.codex/artifacts/sevro-repository-prepare-20261016/target`.

## Slice 1: repository revision changes during extension preparation

The real extension changes README to `advanced by preparation\n`, stages it,
and makes a deterministic commit before returning its valid empty preparation.
The original source revision is
`f4d351b20b90e67f9e9092777856c0135110b023`; the actual TypeScript capture records
the new revision as `75dd20f9ddd25b0c985a44f01bc865a813bb2f32` with clean status.

Oracle — `python3 /tmp/sevro-repository-prepare-oracle.py revision`:
the actual TypeScript CLI returned exit 70 and
`sevro.runner.error` / `repository source changed during run`. The result has
null run/evidence paths, no cases, `not_run` execution, `not_requested` grading,
and `not_assessed` task. One empty reserved workspace remains. The extension's
completion marker exists, and the synthetic native executable was never called.
The capture is under `revision-typescript/`.

Red — `cargo test --offline --locked -p sevro --test run_repository preparation_mutation::refuses_repository_revision_changed_during_extension_preparation -- --exact`:
the unchanged Rust runner returned exit 0 and successful dry-run evidence using
the advanced source revision, instead of refusing with exit 70. The new test
was present before any production change.

The Rust handoff now separates extension case resolution from preparation.
`ResolvedExtension` owns the actual session and resolved wire value.
`ResolvedFixture` owns the validated source map, resolved repository snapshot,
and fixture paths. The runner resolves that fixture before calling the trusted
extension's `prepare`, then consumes the saved fixture snapshot with the returned
setup and artifacts. The existing repository clone guards perform the refusal;
no Git comparison or filesystem defense was removed or duplicated.

Extension schema/correlation validation, instrumentation refusal, setup semantic
validation, and capability checks retain their order within preparation. Native
execution preparation remains after completed fixture preparation. The source
snapshot and its source validation now precede trusted preparation, matching the
required TypeScript repository ordering. Case declarations, identity JSON, and
evidence serialization are unchanged.

Green — `cargo test --offline --locked -p sevro --test run_repository preparation_mutation::refuses_repository_revision_changed_during_extension_preparation -- --exact`:
1 test passed in 0.80 seconds. Assertions cover the literal refusal, intentional
source commit/bytes and clean status, absent host invocation/completed records,
and the retained empty workspace.

## Slice 2: preparation removes the repository's HEAD

Only after the first green, a second actual TypeScript invocation removed the
owned source repository's `.git/HEAD` during `prepare`, before returning a valid
empty preparation response. Its original README bytes remain unchanged.

Oracle — `python3 /tmp/sevro-repository-prepare-oracle.py missing-head`:
the actual TypeScript CLI returned exit 70 and
`sevro.runner.error` / `repository fixture Git operation failed`, with the same
unassessed result shape and one retained empty workspace. No host ran or completed
result/evidence files appeared. The capture is under `missing-head-typescript/`.

Initial green — `cargo test --offline --locked -p sevro --test run_repository preparation_mutation::retains_the_reserved_workspace_when_preparation_removes_repository_head -- --exact`:
1 test passed in 1.63 seconds. The regression also compares the source's raw
index and main-reference bytes before and after invocation. No further product
change was required; this is characterization, not an invented second red.

## Owned cleanup and platform limits

Each test uses a unique real source repository. On macOS the CLI receives the
fixture's private `TMPDIR`. On Linux the test first reexecutes only its exact
name with a recursion marker under the existing required `bubblewrap` setup,
binding a private `/var/tmp` tmpfs before constructing its fixture. The pattern
comes from `runRetentionInIsolation` in [engine.test.ts](../../tests/engine.test.ts).
Assertions enumerate only this owned workspace namespace. Its retained empty
workspace is removed with the owned macOS fixture or Linux mount teardown;
the tests never enumerate/delete shared host workspace reservations. Missing
Linux isolation prerequisites fail instead of skipping the case.

Local macOS results do not establish the Linux nested execution path. The exact
published Ubuntu candidate must validate that wrapper and the retained workspace
assertions. Source repositories and baseline evidence outside the checkout remain
available for inspection.

## Final scoped checks

After the two focused controls passed, the coordinator supplied the ordinary
`cargo fmt --all -- --check` differences for the owned files. Those formatting
changes were applied without changing behavior.

`cargo test --offline --locked -p sevro --test run_repository --test run_extension --test run_dry -- --test-threads=1`
passed: 54 repository tests in 190.63 seconds, 21 extension tests in 53.24 seconds,
and one dry-run test in 0.61 seconds. The full output is retained as
`affected-suites.log` beside the independent TypeScript captures. The existing
real two-minute setup timeout and both new mutation controls passed in this run.

`cargo clippy --workspace --all-targets --offline --locked -- -D warnings`
passed in the same dedicated target. The owned diff whitespace check, scoped
Prettier check, and repository documentation check also passed. These six owned
files are held; whole-candidate formatting, acceptance, and Ubuntu nested-wrapper
validation remain the coordinator's responsibility.
