# Rust result aggregation TDD evidence

The public seam is the single-case `sevro run --json --case-file ...
--adapter-module ... --jobs 1` command. A real Bun adapter returns a declared
sequence of observations or rejects a candidate call. Tests inspect actual
adapter invocations, terminal execution/grading/task states, exit codes and
retained CLI, run, result, latest and trial evidence.

The unchanged TypeScript CLI supplies independent baselines. Existing oracles
include `tests/engine.test.ts`'s `host failure retains completed trials and
reports execution failure`, `tests/results.test.ts`'s `a case threshold applies
only to fully assessed trials` and `exit precedence preserves the most severe
operational failure`, and the [results contract](../results-v1.md).

The current public CLI selects one case, as does `runEvaluation`. Cross-case
aggregation is represented in the TypeScript results tests, but this slice does
not invent a multi-case CLI or test private Rust aggregation helpers.

Commands run from the worktree root with the pinned Rust toolchain selected.
The literal Cargo commands below run through lean-ctx with explicit
`CARGO_HOME`, `RUSTUP_HOME` and the toolchain's `cargo/bin` on PATH.

## Admission stops after host failure

The baseline adapter completes trial 1 with `ready`, rejects trial 2 and would
complete trial 3 if admitted. With three requested trials and `--jobs 1`, the
TypeScript CLI invokes the adapter twice. It exits 2 with failed execution,
completed grading and an unassessed task. Trial 1 remains passed; trial 2 has
failed execution, no requested grading and no check results. Its diagnostic
does not reveal the private host exception.

- Red — `cargo test --locked -p sevro --test run_results host_failure_stops_admission_and_preserves_completed_trial_results -- --exact`:
  Rust invoked the real adapter three times instead of the required two after
  the second call failed.
- Green — `cargo test --locked -p sevro --test run_results host_failure_stops_admission_and_preserves_completed_trial_results -- --exact`:
  one test passed after the runtime owner stopped admission following a failed
  trial, after retaining its evidence.

The regression also checks that all retained result copies agree, the first
trial's `ready` bytes survive, successful workspace cleanup occurs, and the
failed workspace and duration remain available without fabricated raw output.

## Mixed observations and failure precedence

The following tests were added sequentially after admission was green. Each
passed on its first run and is recorded as acceptance characterization, not
claimed red/green implementation evidence. Each expected state was observed
first through the unchanged TypeScript CLI using the same real adapter sequence.

- `cargo test --locked -p sevro --test run_results missing_output_prevents_a_threshold_pass_without_stopping_completed_trials -- --exact`
  runs `ready`, null and `ready`. All three candidates execute, but the missing
  observation makes grading unavailable and leaves the task unassessed with
  exit 4, despite two passed trials and a `0.5` threshold. The missing message
  has no raw-result path, digest or check evidence reference.
- `cargo test --locked -p sevro --test run_results unavailable_grading_preserves_a_failed_trial_and_outranks_task_failure -- --exact`
  runs `no`, incomplete `ready` and complete `ready`. The retained trials remain
  failed, unassessed and passed. Aggregate grading is unavailable, the task is
  unassessed and exit 4 outranks the failed check. All actual bytes survive;
  failed and unavailable workspaces are retained, while the passed one is removed.
- `cargo test --locked -p sevro --test run_results host_failure_outranks_prior_unavailable_evidence_or_failed_assessment -- --exact`
  checks a missing observation followed by host failure, then separately a
  failed check followed by host failure. Both stop after two calls and exit 2.
  Aggregate execution is failed and the task is unassessed, while grading
  remains unavailable or completed respectively. Existing trial outcomes and
  retained workspaces survive, and the failed host produces no fabricated checks.

Every case compares the command result with `run.json`, `result.json`,
`latest.json` and each trial artifact. Host diagnostics remain sanitized across
stdout, stderr and retained evidence.

## A failed latest pointer preserves an earlier run failure

The unchanged TypeScript CLI first established the filesystem-conflict oracle.
`latest.json` is an existing nonempty directory. A real adapter completes the
first trial and rejects the second. The command still exits 2 with failed
execution, completed grading, an unassessed task and its original host-failure
diagnostic. Run, result and trial evidence remain readable through the original
evidence path; the colliding directory and its sentinel file remain unchanged.
Stderr reports that CLI/latest retention failed and the original outcome was
preserved, as required by the [results contract](../results-v1.md).

- Red — `cargo test --locked -p sevro --test run_results latest_pointer_failure_preserves_an_earlier_host_failure_and_evidence -- --exact`:
  Rust replaced the earlier host failure with exit 70 after the real latest
  pointer collision, instead of preserving exit 2 and its evidence reference.
- Green — `cargo test --locked -p sevro --test run_results latest_pointer_failure_preserves_an_earlier_host_failure_and_evidence -- --exact`:
  one test passed after the runtime owner preserved an earlier nonzero outcome
  when final CLI/latest retention fails. The test verifies the original exit,
  states, diagnostic and evidence reference, retained run/result/trial artifacts,
  actual first-trial bytes and the unchanged colliding directory.

## Remaining boundaries

Concurrent admission, cancellation and the complete cross-case result surface
are outside this bounded single-case lifecycle slice. Exact candidate CI remains
the coordinator's responsibility.

At the initial result checkpoint, `cargo test --locked -p sevro --test run_results --test
run_graders` passed all four result tests and all six grader tests.
`cargo clippy --workspace --all-targets --locked -- -D warnings`, owned-file
Rustfmt and Prettier, and `bun run check:docs` passed.

After the latest-pointer precedence repair, `cargo test --locked -p sevro
--test run_results --test run_storage` passed all five result tests and four
storage tests. This includes the existing successful-run publication failure,
which still returns exit 70. Strict workspace/all-targets Clippy, owned-file
formatting and documentation checks passed again. This repair only changes
final CLI/latest publication precedence; it does not suppress earlier trial,
raw-result or run-evidence persistence failures.
