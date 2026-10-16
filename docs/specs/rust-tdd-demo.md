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

## Validation and remaining boundary

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
Rust's existing run failure hint also names supported run options, while
TypeScript's runner-failure hint names writable results/run-state roots. The
independent Rust observation is retained at
`/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-demo-preparation-baseline-Ls8Sih/observation.json`.
The coordinator accepted the cleanup control's outcome/code/filesystem boundary
and held the shared run presentation source; this slice does not claim wording
parity for that existing run error.
The shared runner-failure hint mismatch is deferred to a separate public
run-presentation TDD slice, not accepted as final parity. It is distinct from
the documented operating-system error wording difference.

Cleanup failure before result publication remains unverified. The current demo
guard releases the owned directory after the run command returns, while
TypeScript releases before displaying the result. No race or private cleanup
hook was introduced to manufacture that failure. Tests establish completed
process cleanup on success and on the deterministic preparation failure above,
not cleanup-error precedence or signal behavior during demo preparation.
