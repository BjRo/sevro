# Rust concurrent trials: CLI slice

This records the first bounded worker and adapter multiplexing slice of the
[CLI/engine parity specification](rust-cli-engine-parity.md#concurrency-cancellation-and-retention).
The behavioral contract is
[concurrent trial execution](../development-cli.md#trial-concurrency),
with independent existing regressions in
[`cli-concurrency.test.ts`](../../tests/cli-concurrency.test.ts).

## Public seam and oracle

The durable test invokes the actual `sevro run --json` binary, fixture preparation,
Bun adapter bridge, grading, artifact retention, ownership checkpoints, and
finalization. Only the external candidate is synthetic. Five trials run with
`--jobs 2`; one imported adapter object maintains an active count, peak, and
ordinal. A bounded first-pair barrier exposes serialized execution without
making the red depend on a timeout. Unequal completion delays exercise reply
correlation and ordered results. Every workspace starts with the original marker.

The existing TypeScript CLI concurrency test passed before implementation. An
initial Rust fixture copied that test's custom adapter observations and failed
at the already unsupported adapter-observation boundary. This was a fixture
failure, not the scheduling red. The corrected vector transports the same
samples in supported binary artifacts. An actual unchanged TypeScript CLI run
using that exact extracted adapter vector returned exit 0, peak 2, ordinals 1–5,
ordered trials 1–5, and five original markers. The reproduction and observation
are retained outside the checkout as `concurrency-oracle.py` and
`typescript-concurrency-oracle.json` in `sevro-rust-ownership-20261016`.

## Observed red and green

Both runs used macOS arm64, the pinned Rust compiler, and the same dedicated
target directory outside the checkout. The command was identical:

```sh
cargo test --locked -p sevro --test run_concurrency bounds_parallel_trials_and_retains_ordered_isolated_evidence -- --exact
```

With the corrected test present and production unchanged, the CLI completed
successfully but the assertion observed `Some(1)` instead of `Some(2)` for peak
active calls. After implementation, the same command passed: 1 passed, 0 failed,
0 ignored. The test also verifies one ordinal sequence, distinct isolated
workspaces, cleanup, artifact-to-workspace correspondence, ordered result and
evidence arrays, sorted checkpoint references, and retained trial/result equality.

## Implementation and lifecycle

`records::run` and its `Completion` return type remain unchanged. Scoped workers
bound the whole trial, including fixture materialization, candidate execution,
grading, retention, and cleanup. Admission assigns trial numbers under a brief
mutex. Execution failure or cancellation stops further admission; a persistence
error records the first runner failure and stops admission. All workers drain
before terminal ownership or error finalization. Receipt execution failure closes
admission before retaining its artifacts.

One adapter process imports one object. Private requests carry opaque `rust:`
IDs; replies echo the ID and carry the existing result/error envelope. A dedicated
reader routes out-of-order replies to their waiting calls, while a short writer
lock prevents interleaved frames. Each active run has its own bridge abort
controller. Shared CLI cancellation sends a targeted, one-way abort to every
waiting call. Import interruption keeps the existing process-signal behavior.
Shutdown drains bridge calls before acknowledgment, then Rust reaps the bridge
and drains its diagnostic stream. Adapter stderr forwarding and accepted-receipt
rules remain covered by their existing public regressions.

Only owner checkpoint updates serialize across trials; no candidate holds a
SQLite transaction. Completed references are sorted by trial number. Final
results, evidence, conditions, and diagnostic selection are collected in trial
order even when candidates finish out of order. The prior cleanup ordering is
preserved: persisted passing trials can be cleaned after a checkpoint attempt,
including a failed checkpoint; failed, cancelled, and unpersisted workspaces stay
retained. Existing unknown/dead-owner and retry behavior is unchanged. There is
no age lease or new state-root behavior.

## Controls and validation

Controls were added after the first green, one at a time, and required no further
behavior repair. These are green controls, not additional red/green claims:

- `defaults_to_three_workers_and_honors_serial_execution`: peak 3 with the default
  and peak 1 with `--jobs 1`, with retained jobs configuration.
- `candidate_failure_stops_queued_trials_and_drains_active_peer`: only the active
  pair runs; the peer completes; ordered evidence and complete ownership retain
  both trials; only the failed workspace remains.
- `signals_cancel_every_active_call_and_drain_before_interrupted_finalization`:
  both SIGINT and SIGTERM reach both active calls with their exact reason; no
  queued trial starts; partial raw evidence, both workspaces, and sorted
  interrupted ownership survive drainage.
- `persistence_failure_drains_peer_and_retains_only_unpersisted_workspace`: a
  real artifact-path collision exits 70 after the peer completes, leaving a
  diagnostic owner with the peer's persisted checkpoint and retaining the
  unpersisted workspace.

The failure control initially asserted a status field on the checkpoint, whose
contract has no status. That fixture assertion was corrected to use the active
record before the control passed; production was unchanged.

An additional diagnostic-order slice used the same actual TypeScript CLI with a
failed receipt lacking a message and a successful peer carrying an optional
`failureMessage`. TypeScript retained `sevro.host.failed` with the generic
`host execution did not complete` message. A single Rust invocation initially
passed because adapter arrival and trial admission order are independent. The
durable control exercises four actual admissions with the same expectation;
with production unchanged, it observed `successful peer message` instead of the
generic failed-trial diagnostic. The identical command passed after aggregation
selected the first failed trial, including its absent optional message, rather
than allowing a later successful receipt to fill that absence:

```sh
cargo test --locked -p sevro --test run_concurrency successful_peer_message_cannot_replace_the_failed_trial_diagnostic -- --exact
```

Observed checks:

- `cargo clippy --locked -p sevro --bin sevro --test run_concurrency --test run_ownership -- -D warnings`: passed.
- `cargo test --locked -p sevro --test run_concurrency --test run_ownership --test run_adapter --test run_receipts --test run_results --test run_storage --test run_dry --test run_console --test run_required_evidence --test demo --no-fail-fast`:
  81 passed across ten integration binaries, including prior checkpoint cleanup
  and maximum-artifact/stderr/import-cancellation regressions.
- `bun run typecheck` and
  `bunx eslint src/compat/host-adapter-bridge.ts --max-warnings 0`: passed.
- `bun test tests/cli-concurrency.test.ts tests/run-owner.test.ts tests/run-owner-checkpoints.test.ts`:
  36 passed, 0 failed, 204 assertions.
- `cargo test --locked -p sevro --test run_concurrency --test run_native_codex --test run_native_claude --test run_repository --no-fail-fast`:
  128 passed across four integration binaries before the additional
  diagnostic-order repair, including the two-minute setup timeout and descendant
  termination control.
- `cargo test --locked -p sevro --test run_concurrency --test run_results --test run_ownership --no-fail-fast`:
  final focused sweep passed all 20 tests after the diagnostic-order repair.
- Scoped Rust formatting, Prettier, and `bun run check:docs`: passed.

This slice adds no dependency or service and no new public adapter protocol.
General custom adapter observations, programmatic caller-owned host lifetime and
arbitrary cancellation reasons, separate state roots, recovery CLI, and retained
grading-error parity remain separate work. The Codex agent concurrency setting
controls each private Codex session; it is not a global trial worker limit.
