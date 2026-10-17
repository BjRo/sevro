# Rust demo CLI evidence

The Rust demo uses the packaged `basic-graded` case and its deterministic
TypeScript adapter through the actual adapter bridge. The case retains its
`sevro.regex` grader and `^ready$` expression. Demo assets are embedded from the
existing example files and materialized beside an empty private project, so
they do not change the evaluated project's content identity. Results remain
under `.sevro/results` in the caller's current directory.

## Authority and independent baseline

- [Demo workflow](../../src/cli/demo.ts), the
  [packaged case](../../examples/basic/graded.json), and its
  [adapter](../../examples/basic/host.ts).
- [Existing CLI tests](../../tests/cli/defaults.test.ts): `built-in demo owns its
inputs and reports an assessed verdict from an unrelated cwd`, `demo rejects
unsupported settings as a configuration failure without an assessment`, and
  `demo reports an unusable TMPDIR as one actionable runner failure result`.
- [CLI parity](rust-cli-engine-parity.md),
  [delivery parity](rust-delivery-parity.md), and the
  [result contract](../results-v1.md).

The unmodified TypeScript CLI was run with Bun 1.3.13 on macOS in an unrelated
temporary caller directory containing malformed `sevro.json`, malformed
`.codex/config.toml`, and a dangling unrelated symlink. Both JSON and human demo
completed with exit 0, assessed `basic-graded` as passed, retained the `ready`
regex check and raw response, and removed the temporary project. The empty
project's digest was
`c4758129528fcfd80824a58e21f9d2cfe92fb00e0120120c8eecb8cf9b8b9eaf`.
The latest result and retained run result agreed. Caller policy and symlink
contents remained untouched. The caller's temporary base retained its empty
workspace container, but contained no remaining demo project.

The same probe observed unsupported `--host codex` returning 64 with diagnostic
`demo accepts only --json; run sevro demo --help`. An absent `TMPDIR` returned
one JSON result with exit 70, no assessment or evidence, and the diagnostic
`demo temporary project could not be created under <TMPDIR>; set TMPDIR to a writable directory`.
No subprocess or clock was substituted. Local evidence is retained at
`/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-demo-baseline-P9RaFc/observations.json`;
the probe is `/tmp/sevro-demo-baseline.mjs`. Initial probe assertions were
corrected for macOS canonical paths and the retained workspace container before
recording these observations; those probe mistakes are not product reds.

## Success slice

The public subprocess test copies the built executable into the temporary
consumer directory and runs `demo --json` there. It asserts the original case,
grader, check outcome, actual adapter route and raw `ready` bytes, independent
empty-project identity, retained result/evidence/latest equality, caller-policy
isolation, and removal of the owned project and successful trial workspace.

- Red — `cargo test -p sevro --test demo --locked demo_runs_packaged_case_and_adapter_without_inheriting_caller_policy -- --exact`:
  compiled, then failed with actual exit 64 (`expected the run command`) instead
  of 0. Product code was unchanged.
- The coordinator held demo implementation until the separately owned regex
  prerequisite passed through the unchanged shipped case and actual adapter.
  No grader or case was substituted for demo.
- Green — `cargo test -p sevro --test demo --locked demo_runs_packaged_case_and_adapter_without_inheriting_caller_policy -- --exact`:
  1 passed after adding demo dispatch and the owned input directory. The actual
  run pipeline performs execution, grading, persistence, and successful trial
  cleanup. Demo removes its project and materialized assets when that call
  returns.

Commands used the pinned Rust toolchain through `lean-ctx`; tests required Bun
for the existing TypeScript adapter compatibility bridge. No dependency or
TypeScript source changed in this demo slice.

## Adjacent controls, in execution order

1. Human completion:
   - First-run characterization — `cargo test -p sevro --test demo --locked demo_human_output_reports_the_assessment_and_retained_evidence -- --exact`:
     1 passed without a product change. Human output names the completed,
     assessed pass, trial, candidate measurement and unknown usage, with real
     result/evidence paths matching the latest result.
2. Unsupported demo options:
   - Red — `cargo test -p sevro --test demo --locked demo_rejects_unsupported_options_before_allocating_inputs -- --exact`:
     `demo --json --host codex` incorrectly ran and returned 0 instead of 64.
   - Green — `cargo test -p sevro --test demo --locked demo_rejects_unsupported_options_before_allocating_inputs -- --exact`:
     1 passed after refusing options other than `--json` before allocation.
     The test checks the entire unassessed JSON result, exact diagnostic and
     hint, and empty caller/temporary directories.
3. Unusable temporary base:
   - Red — `cargo test -p sevro --test demo --locked demo_reports_unusable_temporary_directory_as_one_runner_failure -- --exact`:
     an absent `TMPDIR` returned 70 but printed no JSON result.
   - Green — `cargo test -p sevro --test demo --locked demo_reports_unusable_temporary_directory_as_one_runner_failure -- --exact`:
     1 passed after presenting the preparation error as one unassessed result
     with the exact actionable diagnostic and runner-error hint. Its original
     I/O cause remains attached to the contextual preparation error.
4. Cleanup after run storage preparation fails:
   - A fresh actual TypeScript demo encountered an existing caller-owned regular
     file at `.sevro/results`. It returned one unassessed result with exit 70,
     diagnostic code `sevro.runner.error`, no evidence/run ID, and removed its
     owned project while retaining the caller file. The baseline is
     `/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-demo-preparation-baseline-RnP5ip/observation.json`.
   - First-run characterization — `cargo test -p sevro --test demo --locked demo_removes_its_inputs_when_run_storage_preparation_fails -- --exact`:
     1 passed without a product change. The test checks the same exit, states,
     diagnostic code and absent evidence; it uses the public effective settings
     to verify removal of the actual project, case and adapter paths. The
     existing caller file remains unchanged and no replacement storage exists.

## Initial validation and follow-up boundaries

The five cases above were run sequentially through the compiled public CLI.
Final focused checks passed:

- `cargo test -p sevro --test demo --locked -- --test-threads=1`: 5 passed,
  0 failed, 0 ignored, 0 filtered out.
- `cargo clippy -p sevro --lib --test demo --locked -- -D warnings`.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/src/demo.rs crates/sevro/src/lib.rs crates/sevro/tests/demo.rs`.
- `bunx prettier --write docs/specs/rust-tdd-demo.md` and `bun run check:docs`.

The coordinator retains broader CLI/adapter regression and acceptance checks;
this slice did not launch a workspace suite.

No product source outside `demo.rs` and the `lib.rs` dispatch changed in this
slice. The exact shipped assets and generic grader remain shared with the
TypeScript baseline. The bridge still requires Bun; this is not a replacement
native adapter implementation.

Storage-failure diagnostic wording is not byte-for-byte identical. The observed
TypeScript message was `EEXIST: file already exists, mkdir '<results-root>'`;
Rust reports `cannot create directory <results-root>: File exists (os error 17)`.
At that initial boundary Rust's run failure hint named supported run options,
while TypeScript's runner-failure hint named writable results/run-state roots. The
independent Rust observation is retained at
`/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-demo-preparation-baseline-Ls8Sih/observation.json`.
The coordinator accepted the cleanup control's outcome/code/filesystem boundary
and held the shared run presentation source; this slice does not claim wording
parity for that existing run error.
The separate [storage presentation slice](rust-tdd-storage.md) subsequently
repaired the runner-failure hint. That change is distinct from both the documented
operating-system error wording difference and the cleanup-order repair below.

## Cleanup failure before display

The initial demo guard ran after the run command displayed its result and
discarded cleanup errors. A later public CLI slice demonstrates and repairs
that behavior without changing the packaged case or adapter.

The oracle is `CLI finalization preserves one result and the earlier failure
(%j)` in [the TypeScript CLI tests](../../tests/cli/defaults.test.ts), together
with [main's release ordering](../../src/cli/command.ts) and
[demo's idempotent cleanup](../../src/cli/demo.ts). The TypeScript test supplies
a throwing release callback: successful assessment becomes exit 70, while
existing task failure or invalid configuration keeps exit 1 or 64. Source
ordering establishes that run evidence, `result.json`, and `latest.json` are
already retained before cleanup. They remain completed and passed when cleanup
alone prevents successful public completion.

The Rust fault mechanism deliberately differs from that TypeScript callback.
The test invokes the real compiled `demo --json` with a PATH-selected Bun
wrapper. Before invoking the actual Bun executable with unchanged arguments,
the wrapper validates that exactly one demo container exists under its owned
`TMPDIR`, with the case, adapter and project already present, and changes that
outer container to mode `0500`. The original adapter still executes through the
real bridge. No product injection option, replacement cleanup routine, polling
race, or synthetic result is used. TypeScript imports its adapter in-process,
so this is not claimed as a matched external TypeScript fault capture.

Before checking the CLI exit, the regression verifies the wrapper's recorded
path, the real container mode, actual `PermissionDenied` on an attempted write,
the retained passing result/evidence/latest equality, and raw `ready` bytes.
This makes non-root permission enforcement and completed execution prerequisites
of the behavioral assertion. The fixture's drop guard restores permissions on
only its own demo containers before removing its owned temporary tree, including
when the intended red assertion panics.

- Red — `cargo test -p sevro --test demo --locked demo_reports_cleanup_failure_once_without_replacing_completed_evidence -- --exact`:
  all fault and retained-evidence controls passed; public exit was 0 instead of
  70 because cleanup failure was ignored after successful display.
- Green — `cargo test -p sevro --test demo --locked demo_reports_cleanup_failure_once_without_replacing_completed_evidence -- --exact`:
  1 passed after the coordinator handed off the narrow run-command release
  boundary. Demo now releases once before display. A cleanup error following
  successful assessment becomes a typed `RunError` with its original I/O cause
  and one exit-70 unassessed JSON result. Retained passing evidence is untouched.
  Ordinary `run` uses a no-op release callback. Earlier nonzero results retain
  their precedence and emit a cleanup warning if release also fails.

Final focused checks for this follow-up passed:

- `cargo test -p sevro --test demo --locked -- --test-threads=1`: 6 passed,
  0 failed, 0 ignored, 0 filtered out.
- `cargo test -p sevro --test run_adapter --locked executes_existing_typescript_adapter -- --exact`:
  1 passed, exercising the unchanged normal-run route.
- `cargo clippy -p sevro --lib --test demo --test run_adapter --locked -- -D warnings`.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/src/demo.rs crates/sevro/src/run.rs crates/sevro/tests/demo.rs`.
- `bunx prettier --write docs/specs/rust-tdd-demo.md` and `bun run check:docs`.

This follow-up owns only `demo.rs`, the narrow `run.rs` handoff, the public demo
tests, and this ledger. It adds no dependency and changes no TypeScript source.
The new permission-denial observation was made on non-root macOS; no matching
TypeScript filesystem-fault capture or new signal-during-demo-preparation
observation is claimed. The broader source acceptance and compiler coverage
gates remain coordinator-owned.

## Executable fixture copying under parallel tests

The published Ubuntu branch-coverage job for
`faff8bae429a9b84f1b7dc4869c2d3b5e2f2cd62`
[failed two of the five demo tests](https://github.com/BjRo/sevro/actions/runs/38950746546/job/117141566772)
before Sevro started. Both `Command::output` calls returned
`ExecutableFileBusy` (`Text file busy`, OS error 26), at the published
`tests/demo.rs` lines 27 and 215. The other three tests passed. Each test copied
the executable into its own UUID directory; this was a fixture failure, not a
product-behavior red.

The concrete diagnosis is an inference from the fixture and the documented
[Rust Unix executable-copy/spawn race](https://github.com/rust-lang/rust/issues/114554).
A thread copying an executable opens its destination for writing. A concurrent
process spawn can inherit that descriptor until the child executes, so closing
the copying thread's descriptor does not ensure that the executable has no
writer. Distinct destination names do not prevent this inheritance. The CI
compiler's Unix copy/spawn implementation permits this ordering; the log does
not trace the actual writer process. No traced descriptor or local Linux
reproduction is claimed.

The fixture now runs `/bin/cp` with explicit source and destination arguments,
waits for its completion, and reports copy startup or exit failures with path
and process diagnostics. Only that child opens the executable destination for
writing. The test process stages the cleanup test's Bun wrapper as a separate,
non-executed file, then uses the same child-copy helper before setting executable
permissions. That wrapper was absent from the published five-test failure; its
materialization had the same avoidable descriptor exposure in the new sixth
test. UUID isolation, actual adapter execution, permission restoration and the
cleanup assertions remain unchanged. No retry or test serialization was added.

- Before repair — `cargo test -p sevro --test demo --locked`: all 6 tests passed
  with default parallelism on macOS. This did not reproduce or clear the Ubuntu
  failure.
- After fixture repair — `cargo test -p sevro --test demo --locked`: all 6 tests
  passed with default parallelism on macOS, including the cleanup-failure case.
  This is local fixture verification, not a claimed Linux green.

Only `tests/demo.rs` and this ledger changed in the fixture repair. The product
cleanup implementation in `src/demo.rs` and `src/run.rs` remained byte-identical.
Published Linux validation remains coordinator-owned.

Scoped fixture checks passed:

- `cargo clippy -p sevro --lib --test demo --locked -- -D warnings`.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/tests/demo.rs`.
- `bunx prettier --write docs/specs/rust-tdd-demo.md` and `bun run check:docs`.
