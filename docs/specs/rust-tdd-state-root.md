# Rust independent state root: public CLI TDD

This records public regressions for the existing
[`--run-state-root` contract](../development-cli.md#project-and-configuration-roots)
and [CLI/engine parity requirements](rust-cli-engine-parity.md#concurrency-cancellation-and-retention).
The CLI now separates retained results from selected ownership and checkpoint
state. Workspace expiry and any new recovery command are outside this slice.

## Public seam and observed oracle

[`retains_evidence_and_ownership_under_independent_roots`](../../crates/sevro/tests/run_state_root.rs)
invokes the real `sevro run --json` CLI with explicit, distinct absolute results
and state roots. One inline fixture, one exact-output check, and one adapter
receipt exercise real evaluation, artifact retention, ownership, checkpointing,
publication, and workspace cleanup. The adapter substitutes only the external
candidate and returns a three-byte artifact alongside `ready`.

Before running the Rust regression, the actual TypeScript CLI executed the same
case and adapter bytes, extracted directly from the Rust test's constants, with
the same arguments and explicit runner/project digests. The oracle passed with
exit 0 and exactly one JSON result. It verified:

- Run evidence, trial evidence, raw response, host artifact, and `result.json`
  live under `results/<runId>`, with `results/latest.json` publishing the result.
- State contains only `owners`, `locks`, `active`, and `<runId>`. The attempt
  directory contains `checkpoint.json`; checkpoint references point to trial
  evidence under results.
- Complete claim and active records use `state/<runId>` for `evidenceDirectory`
  and `results/<runId>/run.json` for `artifactPath`. The claim points to the state
  root's active record, and the active record points to its state checkpoint.
- The SQLite lock is under the state root. Resolved settings retain both selected
  roots, and the passing workspace is removed.

The reproduction is `state-root-oracle.py`; raw observations are
`typescript-state-root-oracle.json`, both retained outside the checkout in
`sevro-rust-ownership-20261016`. This confirms the existing TypeScript layout;
it established the layout before the first Rust red. Later controls below
exercise admission and native isolation separately.

## First observed red and identical green

On macOS arm64 with the pinned Rust compiler and dedicated target directory,
the command was:

```sh
cargo test --locked -p sevro --test run_state_root retains_evidence_and_ownership_under_independent_roots -- --exact
```

The test compiled and failed on its first behavioral assertion: exit 64 instead
of 0, with `invalid CLI arguments: unknown option --run-state-root`. Production
code was unchanged for this slice. There was no fixture timeout or setup error.
After implementing typed root selection and the allocation split, the identical
command passed one test. The result and artifact assertions were unchanged.

## Additional observed red/green slices

Each test below first ran against the actual TypeScript CLI using the same
fixture and command arguments. Each Rust command then failed behaviorally before
the relevant production change and passed unchanged afterward:

```sh
cargo test --locked -p sevro --test run_state_root native_state_nested_under_executable_read_root_stays_private -- --exact
cargo test --locked -p sevro --test run_state_root saved_state_root_resolves_against_the_manifest_directory -- --exact
cargo test --locked -p sevro --test run_state_root selected_state_contents_do_not_change_project_or_evaluation_identity -- --exact
```

- Native protection: a synthetic candidate wrapper invokes the installed Codex
  sandbox with the generated permission profile. Reading and writing the fixture
  workspace succeeds. Reading or writing the selected state marker must fail,
  including when state is beneath the executable's readable directory. TypeScript
  passed; Rust failed with probe status 91 because the state marker was readable.
  Adding the state root to common native protected roots made the identical test
  pass. The wrapper returns a valid synthetic transcript and uses no provider.
- Saved manifest: TypeScript resolved `saved-state` relative to the manifest
  directory. Rust exited 64 for an unknown saved option. Registering the option
  and its path handling made the identical test pass.
- Provenance: TypeScript kept project and evaluation identities stable after
  state writes, while a real project edit changed the project digest. Rust first
  changed the digest after state writes. Excluding both selected storage roots
  from provenance made the identical test pass.

External reproductions are `state-root-native-oracle.py`,
`state-root-manifest-oracle.py`, and `state-root-provenance-oracle.py` in the same
artifact directory. Their `typescript-state-root-*-oracle.json` observations
retain the actual commands and results. Native coverage here ran on macOS arm64;
this is not a claim of an independently executed Linux sandbox check.

## Sequential controls

Each following public CLI control passed on its first run after its prerequisite
slice. These are regression controls, not additional claimed red/green cycles:

- Omitted state root defaults to the selected results root.
- Empty state root is rejected before ownership or candidate admission.
- A live equivalent run is refused in the selected state root. Finalization
  permits a fresh attempt and preserves the previous active record.
- A pre-existing regular file at `state/owners` blocks initialization. Both newly
  allocated attempt directories are removed, the blocking bytes survive, and
  the candidate is never invoked. The TypeScript initialization-failure test in
  `tests/evaluation/trial-retention.test.ts` also passed independently.
- A native candidate cannot read or write an ordinary independent state root;
  workspace access still succeeds. This first passed through the existing deny
  policy; the nested-executable case above supplied the behavioral red.
- An explicit CLI state root replaces the saved manifest path without allocating
  the unused saved state directory.

## Integration and compatibility

The existing TypeScript allocation oracle is
[`allocateRunResources`](../../src/evaluation/resources.ts). Rust now keeps
distinct internal results and state directories while preserving serialized
claim fields. `RunOwner::directory()` returns the results directory:

- Options accept and resolve `run-state-root`, defaulting to results. Saved
  manifest paths resolve at the manifest, and explicit CLI selection wins.
- Resolved settings retain the selected state root; project provenance excludes
  both storage roots. Native protection includes the selected state root.
- The allocator creates both attempt directories when distinct and keeps
  claims/locks/active/checkpoint state separate from result artifacts.
  Pre-admission guards remove only newly allocated attempt directories. Once
  the claim is published, both allocations remain on a subsequent commit error.
- The only `records.rs` change passes both roots to `RunOwner::start`; the
  evaluator API, scheduling, schema grading-error retention, and cleanup order
  are preserved. No dependency or TypeScript production change is required.

SQLite ownership still uses the existing brief immediate transaction, identity
verification, and confirmed-dead recovery rules. Root selection introduces no
age lease, new recovery command, workspace retention policy, or multi-file
atomicity guarantee.

## Scoped validation

On macOS arm64, the dedicated Rust ownership target passed 279 integration
tests: all 10 state-root tests and the existing ownership, concurrency, options,
provenance, imported configuration, grader, native Codex, and native Claude
suites. This includes the schema runtime-error evidence regression and prior
checkpoint-failure cleanup controls.

The TypeScript CLI/evaluation trial-retention suites passed 13 tests and 84
assertions. Default-feature all-target Clippy with warnings denied, workspace
format checking, ledger Prettier, and documentation checks passed. These are
scoped local checks; publication and full acceptance remain root-coordinated.
