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

At this first cohort boundary, generated hooks and fixture binaries remained
unsupported. The following cohort adds generated hooks.
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

## Generated Git hooks

The next cohort preserves the generated declaration in
`generated Git hooks run for host commits after fixture preparation` from
[the TypeScript tests](../../tests/generated-fixture.test.ts). Its history has
one `Initialize` commit containing `README.md: "source\n"`; its overlay adds
`READY.txt: "new\n"`. The declared `pre-commit` hook is:

```sh
#!/bin/sh
echo 'hook blocked commit' >&2
exit 1
```

The actual unchanged TypeScript CLI capture is
`/private/tmp/sevro-generated-hooks-oracle.fKZ84J/observation.json`. Its retained
`capture.mjs`, `case.json` and `observer.mjs` bind the exact command and inputs.
The real adapter stages `READY.txt`, attempts an actual Git commit, and returns
the observed Git state, process outcome and hook metadata as its final message.
A valid-JSON output check assesses that receipt. The candidate commit exits 1,
its stdout is empty, and stderr is exactly `hook blocked commit\n`. HEAD stays
`46c49149aa29880bc2e54ffeb5270c7bc97329b6` on `main`, with subject `Initialize`
and the fixed fixture author/committer at epoch `946684800`. Index status is
`A  READY.txt`; staged and working bytes are both `new\n`. The hook is a regular,
nonsymlink file with mode `0755` under caller umask `077`. The completed CLI
result passes with fixture digest
`1a071c1a0a3422f7611c5c6350137f0f5b4a8683eeca18d0fe9b7e6489bffb3c`.
The successful workspace is removed.

- Red — `cargo test -p sevro --test run_generated --locked installs_generated_hooks_after_history_and_blocks_candidate_commits -- --exact`:
  the unchanged Rust candidate compiled and returned 64, `invalid case file:
invalid generated fixture`, instead of executing the declaration.
- Green — `cargo test -p sevro --test run_generated --locked installs_generated_hooks_after_history_and_blocks_candidate_commits -- --exact`:
  1 passed after preserving the optional hook map in identity and installing it
  after generated commits, overlay commits and staging. The durable test binds
  the complete independent host receipt and fixture digest.

### Declaration bounds and diagnostics

Independent TypeScript CLI captures from `/tmp/sevro-hook-controls.mjs` are
retained under `/private/tmp/sevro-hook-controls.UtOKKr`, with a summary and
one exact invocation/result per input. They confirm the shared
[fixture-tool validation](../../src/fixtures/tools.ts): at most 32 hooks,
lowercase hook names matching `^[a-z][a-z0-9-]*$` and at most 64 characters,
nonempty string contents without NUL, and at most 1 MiB of aggregate UTF-8 name
and content bytes. Invalid declarations return 64 with `invalid fixture hooks`
inside the named case-file diagnostic and create no results directory.

Each following test was added only after the preceding slice was green:

- Red — `cargo test -p sevro --test run_generated --locked rejects_hook_names_that_escape_the_hooks_directory_before_admission -- --exact`:
  `../escape` was installed and the run passed with exit 0.
- Green — `cargo test -p sevro --test run_generated --locked rejects_hook_names_that_escape_the_hooks_directory_before_admission -- --exact`:
  1 passed after validating hook names before admission.
- Red — `cargo test -p sevro --test run_generated --locked bounds_generated_hooks_to_thirty_two_entries -- --exact`:
  32 hooks passed, but 33 also passed instead of returning 64.
- Green — `cargo test -p sevro --test run_generated --locked bounds_generated_hooks_to_thirty_two_entries -- --exact`:
  1 passed after enforcing the 32-entry bound.
- Red — `cargo test -p sevro --test run_generated --locked bounds_hook_names_and_contents_by_utf8_bytes -- --exact`:
  the exact 1 MiB declaration passed with the independently captured digest,
  but adding one byte also passed instead of returning 64.
- Green — `cargo test -p sevro --test run_generated --locked bounds_hook_names_and_contents_by_utf8_bytes -- --exact`:
  1 passed after bounding aggregate name and content bytes. The fixture uses
  multibyte `é` contents to distinguish UTF-8 bytes from character counts.
- Red — `cargo test -p sevro --test run_generated --locked rejects_empty_hook_contents_before_admission -- --exact`:
  empty contents passed with exit 0 instead of returning 64.
- Green — `cargo test -p sevro --test run_generated --locked rejects_empty_hook_contents_before_admission -- --exact`:
  1 passed after requiring nonempty contents.
- Red — `cargo test -p sevro --test run_generated --locked rejects_nul_in_hook_contents_before_admission -- --exact`:
  a hook containing NUL passed with exit 0 instead of returning 64.
- Green — `cargo test -p sevro --test run_generated --locked rejects_nul_in_hook_contents_before_admission -- --exact`:
  1 passed after refusing NUL contents.
- Red — `cargo test -p sevro --test run_generated --locked refuses_null_hooks_instead_of_treating_them_as_omitted -- --exact`:
  `hooks: null` was erased by optional-field deserialization and passed.
- Green — `cargo test -p sevro --test run_generated --locked refuses_null_hooks_instead_of_treating_them_as_omitted -- --exact`:
  1 passed after preserving the direct-case refusal before deserialization.
- Red — `cargo test -p sevro --test run_generated --locked reports_invalid_hook_map_shapes_at_the_named_case_boundary -- --exact`:
  `hooks: []` returned 64 with the generic generated-fixture diagnostic rather
  than the named case-file `invalid fixture hooks` diagnostic.
- Green — `cargo test -p sevro --test run_generated --locked reports_invalid_hook_map_shapes_at_the_named_case_boundary -- --exact`:
  1 passed after checking the map shape at the direct-case boundary.
- Red — `cargo test -p sevro --test run_generated --locked reports_nonstring_hook_contents_at_the_named_case_boundary -- --exact`:
  numeric hook contents returned the generic generated-fixture diagnostic.
- Green — `cargo test -p sevro --test run_generated --locked reports_nonstring_hook_contents_at_the_named_case_boundary -- --exact`:
  1 passed after naming invalid map values before deserialization.

Two additional public cases passed on their first invocation without product
changes; no behavioral red is claimed:

- `cargo test -p sevro --test run_generated --locked preserves_distinct_identities_for_omitted_and_empty_hooks -- --exact`:
  omitted hooks retain digest
  `228cfbfcbecb0fed17176dd0e8cb08243a904d23352d77d428d68183574444ee`;
  an explicit empty map has digest
  `99be14c6cdb918e72fc864fc0681a91fc72ffcbc5229b719af20e826930042cb`.
  Both retain identical generated Git history.
- `cargo test -p sevro --test run_generated --locked accepts_only_bounded_lowercase_hook_names -- --exact`:
  a 64-character name passes with independently captured identity; a
  65-character, uppercase or empty name is refused before admission.

### Executable installation and retained failures

The public filesystem controls use the existing PATH-selected Git collaborator.
A fixture-owned wrapper executes real Git with unchanged arguments. Only after
successful `git init` does it establish the selected hook target/directory in
the newly allocated workspace; subsequent Git commands execute unchanged. There
is no production injection hook, substituted Git implementation, or timing race.
The wrapper is installed by a waited `/bin/cp` child so the test runner never
opens its executed destination for writing. A child shell sets umask `077`
without changing the parallel test process's global umask.

The independent unchanged TypeScript CLI captures use that same mechanism:
`/tmp/sevro-hook-installation-oracle.mjs` and
`/private/tmp/sevro-hook-installation.3M886L/summary.json`. The TypeScript
[executable installation tests](../../tests/fixtures/executable-installation.test.ts)
also establish the regular-target replacement and nonfile/symlink refusals.

These five durable Rust commands each passed on their first invocation; they
characterize the installer added by the first hook slice:

- `cargo test -p sevro --test run_generated --locked replaces_existing_hooks_after_runner_commits_and_sets_mode_under_private_umask -- --exact`:
  an existing executable pre-commit hook would exit 78, but runner history
  succeeds because runner Git commands disable hooks. Installation replaces
  its bytes and mode `0700` with the declared hook and `0755`; the candidate
  commit then runs the declared hook and exits 1. HEAD and fixture digest match
  the original oracle, and the successful workspace is removed.
- `cargo test -p sevro --test run_generated --locked refuses_a_symlink_hook_target_without_replacing_its_destination -- --exact`:
  exit 70, `fixture Git hook target is invalid`; the symlink and its external
  destination's original bytes remain intact.
- `cargo test -p sevro --test run_generated --locked refuses_a_directory_hook_target_without_removing_its_contents -- --exact`:
  exit 70 with the same target diagnostic; the directory's original file remains.
- `cargo test -p sevro --test run_generated --locked refuses_a_regular_file_in_place_of_the_hooks_directory -- --exact`:
  exit 70, `fixture Git hooks directory is invalid`; the original file remains.
- `cargo test -p sevro --test run_generated --locked refuses_a_symlink_hooks_directory_without_writing_outside_the_workspace -- --exact`:
  exit 70 with the same directory diagnostic; the symlink and external directory
  remain unchanged.

Each failure assertion compares the complete unassessed public JSON result,
checks absence of a published latest result, and verifies the admitted workspace
is retained. The test guard then removes only its own recorded workspace, after
verifying the matching ownership marker inside `.git`, even if an assertion
fails. This fixture cleanup does not change the product's retention contract.

The shared `fixtures/tools.rs` module owns declaration bounds and executable
installation. Hook wrappers retain their own name predicate, count and error
messages. Generated hooks use the existing fixture identity, materialization
and cleanup paths. Repository hooks and fixture binaries remain separate
follow-ups; no host/request/PATH plumbing, dependencies or Git metadata changed.
The declared 128-commit bound retains precedence over hook-content validation.

Final hook-cohort checks passed on macOS, using the same dedicated Cargo target:

- `cargo test -p sevro --test run_generated --test run_dry --locked`: all 22
  generated tests and the inline dry test passed with default parallelism.
- `cargo test -p sevro --test run_repository --locked overlay::`: all 10 selected
  overlay/staging tests passed; 49 unrelated repository tests were filtered.
- `cargo test -p sevro --test run_repository --locked preparation`: all 22
  selected preparation/artifact controls passed; 37 unrelated tests were filtered.
- `cargo clippy -p sevro --lib --test run_generated --test run_repository --test run_dry --locked -- -D warnings`.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/src/run/fixtures/generated.rs crates/sevro/src/run/fixtures/tools.rs crates/sevro/src/run/fixtures.rs crates/sevro/src/run/preparation.rs crates/sevro/tests/run_generated.rs`.
- `bunx prettier --write docs/specs/rust-tdd-generated-fixtures.md` and
  `bun run check:docs`.

This cohort does not claim Linux execution, coverage-gate results or a complete
filesystem I/O-error matrix. It adds no permission-race probes or coverage
exemptions. Combined acceptance and publication remain coordinator-owned.

## Generated path, history-entry and UTF-8 boundaries

This test-only cohort uses the real `sevro run --json --case-file` seam. The
independent expectations come from `generated fixture declarations refuse
case-colliding overlay files` and `generated declarations bound all history
file entries and total UTF-8 bytes` in
[the TypeScript declaration tests](../../tests/fixtures/declaration-validation.test.ts),
the [generated fixture contract](../development-cli.md), and actual unchanged
TypeScript CLI invocations. Direct case files reach the fixture semantic checks;
these vectors do not depend on invalid extension envelopes rejected by an
earlier schema.

The external reproducer is `/tmp/sevro-generated-boundaries-oracle.mjs`.
Running `bun /tmp/sevro-generated-boundaries-oracle.mjs <vector>` creates an
owned temporary directory containing the case, real adapter, and
`observation.json` with literal CLI arguments, stdout, stderr and exit status.
The adapter observes actual Git history and file bytes; it implements no fixture
preparation or validation. The retained oracle directories are:

| Vector           | Oracle directory                                              | Observed public outcome                                             |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| `case-collision` | `/private/tmp/sevro-generated-boundary-case-collision.WpEzw3` | Exit 64, `generated fixture paths collide`, no results directory    |
| `file-limit`     | `/private/tmp/sevro-generated-boundary-file-limit.BldgXc`     | Exit 0, one commit with 1024 tracked files                          |
| `file-over`      | `/private/tmp/sevro-generated-boundary-file-over.by9oej`      | Exit 64 after one extra overlay entry, no results directory         |
| `history-over`   | `/private/tmp/sevro-generated-boundary-history-over.ZNdUpK`   | Exit 64 after a second commit repeats one existing path, no results |
| `utf8-limit`     | `/private/tmp/sevro-generated-boundary-utf8-limit.GNnlxN`     | Exit 0 at 33,554,432 aggregate UTF-8 bytes                          |
| `utf8-over`      | `/private/tmp/sevro-generated-boundary-utf8-over.F0OKqu`      | Exit 64 at 33,554,433 aggregate UTF-8 bytes, no results directory   |

The collision uses the exact `Notes.txt: first` and `notes.txt: second` overlay
from the TypeScript declaration test. The file-count baseline declares 1024
distinct `file-<index>.txt` history entries. Adding `extra.txt` in the overlay
exceeds the aggregate count. Adding a second commit that changes `file-0.txt`
also exceeds it: repeated paths are distinct history entries even though the
path-collision inventory deduplicates exact repeats.

The UTF-8 baseline has commit message `Baseline`, path `data.txt`, and
16,777,208 copies of `é`. The message and path contribute 16 bytes; contents
contribute 33,554,416 bytes. The negative vector appends one ASCII byte. Both
vectors contain fewer than 32 MiB characters, so a character-count limit would
incorrectly admit the negative vector. The positive adapter receipt reports one
tracked file, one commit, 33,554,416 content bytes and `éé` as the first/last
characters. The independently observed fixture digests are
`9dc1b44dce63eac6f010b71bf327bd3a1ed0fd5bf6b3e72ccbf22adae24e3e34`
for the 1024-entry baseline and
`da214e5211e6a40aef3c7a9178a43689e44d9b84d18d3ba27fbaaa8eef8a3b9a`
for the exact UTF-8 limit. The tests assert these fixed observations rather than
recomputing fixture identity.

Each test was added only after the preceding test passed. Every first run passed
against unchanged product code, so these are characterizations, not claimed
red/green repairs:

- First-run characterization — `cargo test -p sevro --test run_generated --locked rejects_case_colliding_generated_overlay_paths_before_admission -- --exact`:
  1 passed; raw output `case-collision.log`.
- First-run characterization — `cargo test -p sevro --test run_generated --locked accepts_exactly_1024_generated_history_file_entries -- --exact`:
  1 passed; raw output `file-limit.log`.
- First-run characterization — `cargo test -p sevro --test run_generated --locked counts_generated_overlay_entries_toward_the_history_file_limit -- --exact`:
  1 passed; raw output `file-over.log`.
- First-run characterization — `cargo test -p sevro --test run_generated --locked counts_repeated_generated_paths_in_each_history_entry -- --exact`:
  1 passed; raw output `history-over.log`.
- First-run characterization — `cargo test -p sevro --test run_generated --locked accepts_exactly_32_mib_of_generated_utf8_history -- --exact`:
  1 passed; raw output `utf8-limit.log`.
- First-run characterization — `cargo test -p sevro --test run_generated --locked rejects_generated_history_one_utf8_byte_above_32_mib -- --exact`:
  1 passed; raw output `utf8-over.log`.

Raw Cargo logs are retained under
`/tmp/sevro-generated-boundary-evidence.PZ9O5g/`. All commands use the pinned
toolchain, dedicated `CARGO_TARGET_DIR=/tmp/sevro-generated-target.jMxLbl`, and
`lean-ctx`. Rejected cases compare the complete unassessed JSON result and exact
named case-file diagnostic (`generated fixture exceeds the size limit` for
count/byte limits), with no run ID, evidence path or results directory. Accepted
cases execute real Git materialization and compare persisted evidence and the
adapter receipt. No product files, frozen repository-hook files, thresholds,
exclusions or dependency manifests changed.

Final boundary-cohort checks passed on macOS:

- `cargo test -p sevro --test run_generated --locked`: all 28 tests passed with
  default parallelism, none ignored or filtered; `generated-suite.log`.
- `cargo clippy -p sevro --lib --test run_generated --locked -- -D warnings`:
  passed; `clippy.log`.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/tests/run_generated.rs`:
  passed; `format-check.log`.
- `bunx prettier --write docs/specs/rust-tdd-generated-fixtures.md` and
  `bun run check:docs`: passed; `prettier.log` and `docs.log`.

This bounded cohort does not claim complete generated-fixture boundary coverage,
Linux execution, a global coverage result or publication acceptance. It adds six
public characterization tests and changes no product behavior.
