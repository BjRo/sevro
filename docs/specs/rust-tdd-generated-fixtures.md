# Rust generated fixture slices

This ledger records public CLI parity work against
[the generated-fixture contract](../development-cli.md),
[the fixture parity inventory](rust-fixtures-graders-parity.md), and the
TypeScript implementation. It preserves the existing `sevro run` invocation
and uses actual Git and the TypeScript adapter compatibility bridge.

## Declared history and staged overlay

The first fixture matches `CLI accepts generated Git history from a case or
extension` in [the CLI tests](../../tests/cli/fixture-preparation.test.ts):

```json
{
  "kind": "generated",
  "commits": [
    { "message": "chore: initialize", "files": { "README.md": "fixture\n" } }
  ],
  "files": { "README.md": "staged\n" },
  "staged": ["README.md"]
}
```

An independent actual TypeScript CLI invocation used a real adapter to observe
Git's history, index and working tree. It returned a completed, assessed pass
with one valid-JSON output check. The capture is
`/private/tmp/sevro-generated-baseline.Ztqtjz/observation.json`; the external
probe is `/tmp/sevro-generated-baseline.mjs`.

The retained fixture digest is
`228cfbfcbecb0fed17176dd0e8cb08243a904d23352d77d428d68183574444ee`.
It hashes the declaration above plus `artifacts: []`; absent optional fields
such as `commitFiles`, `hooks` and `bin` are not invented. The Git HEAD is
`5bc31024b9c366e7f2cda7ea410571fd19acb472`, on branch `main`. Author and committer
are `Sevro Fixture <fixture@sevro.invalid>` at `2000-01-01T00:00:00Z`, despite
conflicting caller identity/date environment variables. Committed README bytes
remain `fixture\n`, index and working-tree bytes are `staged\n`, and status is
`M  README.md`. The successful workspace is removed while run/result/latest
evidence remains.

- Red — `cargo test -p sevro --test run_generated --locked prepares_generated_history_and_staged_overlay -- --exact`:
  compiled and failed with exit 64 (`unknown field commits`) instead of 0.
  No product code had changed.
- Green — `cargo test -p sevro --test run_generated --locked prepares_generated_history_and_staged_overlay -- --exact`:
  1 passed after adding the generated declaration and real Git materialization.
  The test compares the independent fixed HEAD, fixture digest, author/date,
  file/index/status bytes and retained result/evidence/latest equality.

The implementation uses the protocol owner's settled resolve-before-prepare
boundary. Generated fixtures count as Git fixtures for setup and artifact
validation. Their artifact collision inventory is the exact-deduplicated union
of every commit path and overlay path, as required by
[the TypeScript plan](../../src/evaluation/plan.ts). It adds no host, options,
records or run-dispatch changes. Git runs with a cleared environment, explicit
fixed authorship, disabled caller configuration and runner-time hooks, and
bounded stdout/stderr readers.

All Rust commands in this ledger use the pinned toolchain and dedicated
`CARGO_TARGET_DIR=/tmp/sevro-generated-target.jMxLbl` through `lean-ctx`.

## Repository metadata refusal

The next actual TypeScript CLI capture at
`/private/tmp/sevro-generated-baseline.mND25d/observation.json` changes the
commit file to `nested/.GIT/config`. It returns exit 64 with the exact named
case-file diagnostic containing `generated fixture cannot write repository
metadata`, no run ID/evidence, and no results directory.

- Red — `cargo test -p sevro --test run_generated --locked rejects_generated_repository_metadata_before_run_admission -- --exact`:
  exit 70 followed a real Git failure during admitted materialization, instead
  of preflight exit 64.
- Green — `cargo test -p sevro --test run_generated --locked rejects_generated_repository_metadata_before_run_admission -- --exact`:
  1 passed after rejecting case-insensitive `.git` path components in every
  history and overlay file before materialization. The test asserts the entire
  unassessed JSON result and absence of run storage.

## Staging declaration refusal

The independent capture at
`/private/tmp/sevro-generated-baseline.eeG3vm/observation.json` stages
`other.txt`, absent from the declared overlay. TypeScript returns exit 64 with
`invalid generated fixture staging` in the named case-file diagnostic and
creates no results directory.

- Red — `cargo test -p sevro --test run_generated --locked rejects_staging_paths_outside_generated_overlay_before_run_admission -- --exact`:
  exit 70 followed an admitted `git add` failure instead of preflight exit 64.
- Green — `cargo test -p sevro --test run_generated --locked rejects_staging_paths_outside_generated_overlay_before_run_admission -- --exact`:
  1 passed after validating membership in the overlay and case-insensitive
  staged-path uniqueness before admission.

## Fresh deterministic trials

The TypeScript capture at
`/private/tmp/sevro-generated-baseline.vo4QnJ/observation.json` adds a second
`feat: revise` commit with README bytes `second\n`, and untracked overlay
`notes.txt`. The actual CLI runs two trials with `--jobs 1`. The adapter observes
Git state and scratch-file absence, then writes that scratch file in its
workspace. Both receipts have HEAD
`60af8ef9645c6689de225867adbc4f34beb622a0`, the two declared commit subjects,
the staged README, untracked notes and `scratchPresent: false`. The fixture
digest is `50217b4d0d477e641093a6a6eeda8cdc707f93090b31d2598fe3e5cca6a83f93`.

- First-run characterization — `cargo test -p sevro --test run_generated --locked gives_generated_trials_identical_history_and_fresh_working_trees -- --exact`:
  1 passed without a product change. The public test checks both exact
  receipts, distinct workspace paths and removal of both successful workspaces.
  This is not claimed as a new behavioral red.

## Committed scaffolding

The independent capture at
`/private/tmp/sevro-generated-baseline.RYMz4T/observation.json` enables
`commitFiles`, adds `guide.txt` with `scaffolding\n`, and omits `staged`.
TypeScript creates `Add evaluation scaffolding` after the initial commit, with
HEAD `4ef2f1bcdce700763c9b30a2fc1ba33d434f6928`, a clean index/working tree, and
fixture digest `91d0af7436bf4b5b5d634f1a03370d6ea81aed55b8c820ee63327a59e95d12ce`.

- Red — `cargo test -p sevro --test run_generated --locked commits_generated_overlay_as_scaffolding_when_requested -- --exact`:
  exit 64 rejected `commitFiles` instead of executing the valid case.
- Green — `cargo test -p sevro --test run_generated --locked commits_generated_overlay_as_scaffolding_when_requested -- --exact`:
  1 passed after committing declared overlay files with the fixed scaffolding
  subject before optional staging. The test binds exact history, identity and
  index/working-tree observations from the independent capture.

## Explicit null is not absence

Inspection identified that ordinary Serde optional fields would erase explicit
`commitFiles: null`. The actual TypeScript CLI capture at
`/private/tmp/sevro-generated-baseline.bs2ARH/observation.json` rejects that
input with exit 64 and a named `invalid generated fixture` diagnostic, without
admitting run storage.

- Red — `cargo test -p sevro --test run_generated --locked refuses_null_generated_options_instead_of_treating_them_as_absent -- --exact`:
  the invalid declaration completed and passed with exit 0 instead of 64.
- Green — `cargo test -p sevro --test run_generated --locked refuses_null_generated_options_instead_of_treating_them_as_absent -- --exact`:
  1 passed after the direct-case input boundary refused explicit null optional
  generated fields before deserialization could erase their presence.

## Cohort boundary

Final fixture review found a portability difference in the observer, not Sevro:
[Git 2.43's strict ISO formatter](https://github.com/git/git/blob/v2.43.0/date.c#L326-L334)
prints zero-offset dates with `+00:00`, while
[the current formatter](https://github.com/git/git/blob/master/date.c#L336-L347)
prints `Z`. The observer now reads Git's `%at` and `%ct` epoch timestamps, both
`946684800`, to assert the same fixed date without depending on that display
spelling. Fresh actual TypeScript captures at
`/private/tmp/sevro-generated-baseline.l9aG60/observation.json` and
`/private/tmp/sevro-generated-baseline.2AXOq7/observation.json` confirm the staged
and scaffolding receipts with unchanged HEADs and fixture digests. This was a
test-fixture portability correction after green; no new product red is claimed.

The generated declaration enforces the source contract's 128-commit limit,
nonblank messages of at most 4,096 UTF-8 bytes, 1,024 total history/overlay file
entries, and 32 MiB aggregate messages, paths, contents and staged-path bytes.
Repeated exact paths contribute to those limits but appear once in the artifact
collision inventory. Case-folded or parent/child path collisions are refused.
These guards are present; this first cohort does not claim a complete public
boundary matrix for each limit or malformed declaration shape.

Generated hooks and fixture binaries remain explicitly unsupported here.
Extension-generated setup/artifact ordering and collision tests are a separate
coordinated follow-up. Repository staged overlays, Git HEAD graders, and native
fixture-tool plumbing are outside this cohort. No TypeScript source, dependency,
host, options, records, run dispatch or product demo file changed in this work.

Final scoped checks passed:

- `cargo test -p sevro --test run_generated --test run_repository --test run_dry --locked`:
  6 generated, 54 repository and 1 inline dry tests passed, with no ignored or
  filtered cases. The repository suite included the unchanged real two-minute
  setup deadline regression and completed in 125.67 seconds.
- `cargo test -p sevro --test run_generated --locked`: all 6 passed again after
  the observer timestamp portability correction, with default parallelism.
- `cargo clippy -p sevro --lib --test run_generated --test run_repository --test run_dry --locked -- -D warnings`.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/src/run/fixtures/generated.rs crates/sevro/src/run/fixtures.rs crates/sevro/src/run/preparation.rs crates/sevro/tests/run_generated.rs`
  passed before the shared fixture/declaration files were handed back to the
  coordinator. The still-owned generated module and test were checked again
  after the observer correction.
- `bunx prettier --write docs/specs/rust-tdd-generated-fixtures.md` and
  `bun run check:docs`.

No Linux execution or workspace-wide compiler coverage is claimed by this
cohort; those remain coordinator-owned. Local captures and checks ran on macOS.
