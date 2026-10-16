# Rust required-evidence assessment

The public `sevro run --json` command now assesses required evidence after
actual host execution and grading. Missing evidence makes grading unavailable
without discarding check results or retained host bytes. A failed check keeps
its failed task verdict; otherwise missing evidence leaves the task unassessed.
Both cases exit 4. The behavior follows the
[result parity specification](rust-protocol-results-parity.md) and is exercised
through the compiled executable in
[`run_required_evidence.rs`](../../crates/sevro/tests/run_required_evidence.rs).

## Independent oracle and first red/green slice

Before changing the Rust behavior, the unchanged TypeScript CLI executed a
real adapter returning the complete message `ready`. Its direct inline case
requested `example.receipt` and had one `sevro.output` check expecting `ready`.
The adapter supplied no such artifact or observation. The TypeScript result was
completed execution, unavailable grading, and an unassessed task, with exit 4.
The passing check, raw message, actual workspace, and mutually consistent
trial/run/result/latest records remained available. There was no diagnostic.
The independent required-evidence digest was
`161c1e21ac93ec931b698c87e715a0186b1a5802b84a294fbd35b61c3a883d1e`.

- Red — `cargo test -p sevro --test run_required_evidence missing_required_evidence_preserves_passing_check_and_returns_unavailable --locked -- --exact`:
  the public Rust command returned 64 with its pending required-evidence
  refusal instead of the baseline's executed result and exit 4.
- Green — `cargo test -p sevro --test run_required_evidence missing_required_evidence_preserves_passing_check_and_returns_unavailable --locked -- --exact`:
  one test passed after replacing the refusal with assessment of actual
  produced artifact IDs and complete built-in observations.

The implementation keeps produced host artifact IDs separate from retained
preparation artifact references. It evaluates evidence availability only after
completed execution; dry, failed, and cancelled host outcomes keep their
existing classification.

## Subsequent observed characterizations

Each following example was first executed through the unchanged TypeScript
CLI, then asserted through the Rust CLI. Each Rust command passed on its first
executable run; these are characterizations, not claimed red/green slices.

- `cargo test -p sevro --test run_required_evidence missing_required_evidence_preserves_a_failed_check_verdict --locked -- --exact`:
  the adapter returns `wait`, so the exact check fails. Missing evidence makes
  grading unavailable while the run, case, and trial task verdicts remain
  failed. Exit 4 and the original raw bytes are preserved.
- `cargo test -p sevro --test run_required_evidence actual_retained_host_artifact_satisfies_required_evidence --locked -- --exact`:
  an actual `Uint8Array` artifact with ID `example.receipt` satisfies the
  requirement. Exit 0, completed grading, and a passed task coexist with
  retained bytes `[0, 255, 128, 10, 13, 42]` and literal SHA-256
  `f58452139dc66886579a1e60a27c45ccfca7ff93ac0490c01a0f26e6c3dbed02`.
  The successful workspace is removed after retention.
- `cargo test -p sevro --test run_required_evidence complete_builtin_observations_satisfy_required_evidence --locked -- --exact`:
  requirements for `sevro.observation.final-message` and
  `sevro.observation.workspaces` are satisfied by the actual complete built-in
  observations. The task passes with exit 0 and retained raw bytes.
- `cargo test -p sevro --test run_required_evidence partial_required_output_is_unavailable_even_without_checks --locked -- --exact`:
  the adapter returns partial `ready` output and the case requests no checks.
  The incomplete required final-message observation still makes grading
  unavailable and the task unassessed, with exit 4 and retained raw/workspace
  evidence. Its first build encountered a concurrent native-constructor API
  transition; that compilation failure is not behavioral red evidence.

The baseline script and original command/result files were retained outside
the repository under `/tmp/sevro-required-evidence-baseline.py` and the
`sevro-required-evidence-baseline-*` temporary directories. The durable tests
contain the literal expected states and bytes rather than recomputing the
production assessment or hashing algorithm.

## Boundary and validation

The five examples above prove availability for actual produced host artifacts
and the two built-in observations. Preparation-artifact availability is not
claimed by these tests. SQLite run ownership, recovery, and concurrent
scheduling also remain separate work.

The later [native continuation slice](rust-tdd-native-hosts.md) adds a typed,
native-only observation receipt. Its public Codex test declares
`sevro.codex.continuation` as required evidence and verifies the actual
same-thread session, boundary ordinal, measured workspace comparison, both
retained event artifacts, and grading of the second response. The core assigns
the selected host as the observation source and satisfies a declared ID only
when its actual completeness is `complete`. It does not construct continuation
facts itself. General adapter observation transport remains unsupported: the
shared field is excluded from adapter deserialization and strict decoding
continues to refuse that unported wire field. A promised observation is never
treated as present.

The native owner separately established that `CodexHost::new` receives only
validated options and made the constructor infallible. The runtime call now
reflects that signature instead of retaining an impossible construction error
branch. Actual private-state creation, credential checks, isolation, process
failures, and cancellation remain fallible at their real execution boundaries.

Final local validation passed:

- `cargo test -p sevro --test run_required_evidence --test run_dry --test run_graders --test run_results --test run_storage --locked`:
  19 public integration tests passed, including all five required-evidence
  examples.
- `cargo clippy --workspace --all-targets --locked -- -D warnings` passed.
- Scoped Rust formatting and `bun run check:docs` passed.

Combined coverage thresholds, independent review, and hosted macOS/Ubuntu
acceptance remain candidate-wide coordinator gates. These focused results do
not claim that the full port or its required coverage gates are complete.
