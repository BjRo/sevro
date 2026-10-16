# Rust fixture TDD evidence

This ledger records the fixture port through the existing public `sevro run`
command. [Fixture parity](rust-fixtures-graders-parity.md) remains the full
acceptance scope. These slices do not establish complete fixture, setup, grading,
or ownership parity.

## Clean repository source for a dry run

The first oracle was captured by invoking the baseline TypeScript CLI against
a new temporary Git repository outside the checkout, before changing Rust
product code. The repository contains `README.md` with `repository fixture\n`,
committed on `main` with message `Create fixture`. Author and committer are
`Sevro Fixture <fixture@sevro.invalid>` at `2000-01-01T00:00:00+00:00`.
Its independently observed Git revision is
`f4d351b20b90e67f9e9092777856c0135110b023`.

The case is `repository-dry`, prompt `Return ready.`, fixture
`{"sourceRef":"fixture-repo"}`, one `sevro.output` check named `answer` with
`expectExact: "ready"`, and required evidence `example.receipt`. A declared
source map binds `fixture-repo` to the repository's file URL within its source
root. The dry Codex route is model `synthetic`, effort `low`, with explicit
runner/project digests consisting of 64 `a`/`b` characters respectively.

Baseline observations were exit 0, `not_run/not_requested/not_assessed`, no
candidate invocation, unchanged source bytes/HEAD/clean status, and these
retained identity dimensions:

| Dimension       | Literal baseline value                                             |
| --------------- | ------------------------------------------------------------------ |
| `caseDigest`    | `f7d9eabd83eb5c418f6f1f634b2b1a28552c83b2853984deb6b6244080eb60c5` |
| `fixtureDigest` | `9af59f403dd73fd49ba50280345e50e0746c6cffd4a75f4872365e2865e1aa19` |

The durable test is
[`prepares_clean_repository_dry_run`](../../crates/sevro/tests/run_repository.rs).
It invokes the compiled binary with `--dry`, `--case-source-root`, and
`--case-source-map-file`, then inspects public result/evidence documents and
independently reads original source bytes/Git state. Expected digests are literal
baseline values; assertions do not call production hashing or fixture helpers.
The test also requires a deleted workspace identified by public retained
workspace evidence and a true resolved `caseSourceMapping` value.

This first test proves source resolution, source immutability, and public identity
and dry-result behavior. Since successful dry workspaces are cleaned before the
command returns, it does not directly prove cloned file/index contents. Later
setup or retained-failure slices must supply that observable evidence.

Red — `cargo test -p sevro --test run_repository prepares_clean_repository_dry_run --locked -- --exact`:
the unchanged Rust command returned 64 with
`unsupported option in the Rust dry-run slice: --case-source-root`; the test
expected exit 0. The deterministic source-revision assertion passed first.

Green — `cargo test -p sevro --test run_repository prepares_clean_repository_dry_run --locked -- --exact`:
passed after implementing repository resolution and materialization and
connecting the fixture to native run identity and lifecycle handling (1 passed).
The existing inline dry-run test also passed
with `cargo test -p sevro --test run_dry --locked` (1 passed), and
`cargo clippy --workspace --all-targets --locked -- -D warnings` passed.

## Negotiated setup observes the materialized repository

The second baseline invocation used a real extension process that negotiated
`sevro.fixture.setup`, resolved the same repository source, and returned a
declared `/bin/sh -c` setup command. The setup compares the worktree README bytes
and committed README bytes, requires the literal baseline revision, an empty
status, no remotes, and detached HEAD. It also checks symbolic project/workspace
environment values, a private HOME/TMPDIR pair, and exclusion of an inherited
private marker. Only after all checks pass does it exit 17. The candidate host
must never start.

The TypeScript CLI returned exit 70 with `sevro.runner.error` and
`fixture setup failed (17)`, null run/evidence paths, no cases, and
`not_run/not_requested/not_assessed`. Setup output is discarded by the existing
contract, so this test uses the public failure diagnostic to establish the
observed clone contents. It does not invent retained evidence for a successful
cleaned workspace or inspect private generated paths.

The durable test is
[`runs_negotiated_setup_in_the_materialized_repository`](../../crates/sevro/tests/run_repository.rs).

Red — `cargo test -p sevro --test run_repository runs_negotiated_setup_in_the_materialized_repository --locked -- --exact`:
the Rust CLI returned exit 0 with successful dry evidence, instead of the
baseline's exit 70. The extension preparation's setup declaration was silently
ignored.

Green — `cargo test -p sevro --test run_repository runs_negotiated_setup_in_the_materialized_repository --locked -- --exact`:
passed (1 passed, 1 filtered out) after validating and executing setup, connecting
the negotiated declaration to the fixture, and including its symbolic identity
and retained configuration digest.

`cargo test -p sevro --test run_repository --test run_dry --locked` then passed
all 3 tests, and scoped rustfmt and documentation checks passed. The integration
owner repaired a Clippy finding in the shared identity hook, then reported
`cargo clippy --workspace --all-targets --locked -- -D warnings` passing.
Setup timeout and group termination are implemented but have no timeout or
cancellation oracle in this slice.
Interruption, owner recovery, successful setup identity, preparation artifacts,
overlay containment, and retention remain separate acceptance work.

## Repository overlay before successful setup

The positive overlay oracle uses the same declared repository and a real
extension setup process. The declaration replaces `README.md` with
`overlay fixture\n` and creates `notes.txt` containing `untracked\n`. Setup
compares those bytes, compares committed README bytes with the unchanged source,
requires the original commit, and checks exactly one unstaged README change and
one untracked note with no staged diff or remotes. It succeeds only after those
checks and the symbolic workspace check pass.

The TypeScript CLI returned exit 0 with dry states and these literal retained
values:

| Dimension                                   | Literal baseline value                                             |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `fixtureDigest`                             | `d604b549559c9da8ac43b088070af0054fe7e406733b7025dc54bf48da3632ab` |
| `configuration.redacted.fixtureSetupDigest` | `9c0c5eccb42cbb37dc54786f8f0e13b06aef21f8a21335008754881e349316f6` |

The durable
[`applies_repository_overlays_before_successful_setup`](../../crates/sevro/tests/run_repository.rs)
test asserts those public values and states, the retained result, cleanup of the
workspace named by public evidence, absence of native host invocation, and
unchanged original source bytes, index, and commit. The retained configuration
contains the setup digest without the setup declaration.

Red — `cargo test -p sevro --test run_repository applies_repository_overlays_before_successful_setup --locked -- --exact`:
the Rust CLI returned 64 with `repository fixture overlays are not yet implemented in Rust`,
instead of the baseline's successful dry result.

Green — `cargo test -p sevro --test run_repository applies_repository_overlays_before_successful_setup --locked -- --exact`:
passed (1 passed, 2 filtered out) after applying validated overlay files before
setup and including the declarations in fixture identity. A concurrent
native-host field change caused a compilation error before the passing rerun;
that integration failure is separate from the observed behavioral red above.

## Repository overlay symlink containment verification

The next baseline case uses a clean repository with a committed `shortcut`
symlink to an external directory containing an unchanged sentinel file. An
overlay attempts to write `shortcut/owned.txt`. The TypeScript CLI returns exit
70 with `repository fixture overlay traverses a non-directory`, null run and
evidence paths, empty cases, and dry failure states. The external directory still
contains only its original sentinel, and the source link, HEAD, and clean Git
status remain unchanged.

`cargo test -p sevro --test run_repository refuses_repository_overlay_through_a_committed_symlink --locked -- --exact`:
passed on its first execution (1 passed, 3 filtered out). This is an additional
public-seam regression check, not an observed red/green slice: the preceding
overlay implementation already included the required symlink refusal. It checks
the full public failure result and independent source/external filesystem state;
it does not infer a private workspace path from implementation details.

The combined fixture, inline, and extension regression command
`cargo test -p sevro --test run_repository --test run_dry --test run_extension --locked`
passed all 11 tests after the overlay changes; scoped rustfmt and documentation
checks passed. Native-host integration was in progress, so its temporary unused
items prevented a stable whole-workspace lint result at this boundary.

## Verified preparation artifact retention

The next baseline extension returns one artifact named `generated-file`, at
`generated/data.txt`, with canonical base64 `cHJlcGFyZWQgZGF0YQo=`. Its declared
and retained SHA-256 is
`738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f`.
The TypeScript CLI returns exit 0 and retains the bytes `prepared data\n` at the
public artifact file URL with mode 0600 after the public workspace path has
been cleaned. Its fixture digest is the literal
`4af1116098c1b2b6cf843d7b1fefffbdf495faeddd21a887c51c2847435ca18c`.

The durable
[`retains_verified_preparation_artifacts_after_fixture_cleanup`](../../crates/sevro/tests/run_repository.rs)
test asserts those values, retained bytes and private mode, dry states and
cleanup, unchanged source state, and absence of candidate execution. Retention
uses the declared verified bytes, independently of mutable candidate files.
This slice establishes public retention; a subsequent setup-created symlink
case supplies separate observable evidence for mount containment and ordering.

Red — `cargo test -p sevro --test run_repository retains_verified_preparation_artifacts_after_fixture_cleanup --locked -- --exact`:
the Rust CLI returned 64 with `extension artifacts and instrumentation are not yet implemented in Rust`,
instead of the baseline's successful dry result.

Green — `cargo test -p sevro --test run_repository retains_verified_preparation_artifacts_after_fixture_cleanup --locked -- --exact`:
passed (1 passed, 4 filtered out) after validating declarations, mounting the
verified bytes after setup, retaining them once per run, and connecting actual
references to trial evidence. Canonical base64 decoding uses pinned
`data-encoding` 2.11.1, already present in the lockfile as a transitive dependency;
the new direct dependency reuses that package.

## Setup-created artifact mount containment verification

The baseline setup command creates `generated` as a symlink to an external
directory containing a sentinel. Mounting the same artifact then returns exit
70 with `preparation artifact traverses a non-directory`, null run and evidence
paths, empty cases, and unassessed states. The external sentinel remains the
only file, and the source repository remains clean and unchanged.

`cargo test -p sevro --test run_repository refuses_preparation_artifact_mount_through_a_setup_symlink --locked -- --exact`:
passed on its first execution (1 passed, 5 filtered out). This verifies required
mount containment already implemented with artifact mounting; no red is claimed.
The test uses the exact public failure result and external/source filesystem
state to establish that setup precedes artifact mounting and that artifact
bytes never follow the setup-created symlink. It does not claim retained run
evidence for this early failure.

## Artifact and source boundary characterization

The next TypeScript baseline invocations establish these exact public failures:

| Input                                         | Exit | Diagnostic message                                        |
| --------------------------------------------- | ---- | --------------------------------------------------------- |
| Incorrect declared artifact SHA-256           | 64   | `preparation artifact digest does not match content`      |
| Base64 missing its required padding           | 64   | `preparation artifact content is not canonical base64`    |
| Duplicate artifact ID at distinct paths       | 64   | `preparation artifact IDs must be unique and nonempty`    |
| Artifact at `.git/config`                     | 64   | `preparation artifacts cannot modify repository metadata` |
| Artifact at `../escaped.txt`                  | 64   | `invalid fixture path: ../escaped.txt`                    |
| Artifact over the cloned `README.md`          | 70   | `preparation artifact path already exists`                |
| Artifact colliding with a declared overlay    | 64   | `fixture paths collide`                                   |
| Source README with uncommitted changes        | 64   | `repository source has uncommitted changes`               |
| Source map pointing outside its declared root | 64   | `repository source escapes its declared root`             |

The two tests in
[`run_repository/boundaries.rs`](../../crates/sevro/tests/run_repository/boundaries.rs)
exercise all nine cases through the compiled CLI, asserting complete public
failure results and preserved source bytes, Git status, commit, and absent host
execution. Exit 64 uses `sevro.invocation.invalid`; exit 70 uses
`sevro.runner.error`. All have null run/evidence paths, no cases, and
`not_run/not_requested/not_assessed`.

`cargo test -p sevro --test run_repository boundaries:: --locked` passed
(2 passed, 6 filtered out) on its first behavioral execution. An initial test
module-path compilation error was corrected before that execution and is not
counted as a behavioral red. No product changes were needed, so these are
characterization checks rather than claimed red/green slices.

Before adding those tests,
`cargo test -p sevro --test run_repository --test run_dry --test run_extension --locked`
passed all 16 tests, including the extension deadline and signal cases. Strict
workspace Clippy and documentation checks also passed at the artifact boundary.

At the checkpoint, `cargo test -p sevro --test run_repository --locked` passed
all 8 tests after shared provenance integration compiled. Scoped fixture/test
rustfmt and documentation checks passed; the core integration owner also
reported strict workspace Clippy passing for that shared boundary. No fixture
behavioral red remains pending. Setup cancellation, artifact source references,
repository staging/commits, generated fixtures, and ownership recovery remain
outside this checkpoint's demonstrated behavior.

## Executable artifact and literal Git exclusion characterization

The baseline extension prepares an executable, Git-excluded artifact at
`tools/a [x]*#!?.sh`. Its bytes are `#!/bin/sh\nprintf 'tool-ready\\n'\n`, with
literal SHA-256
`4dff0af9c31ff94f69d72a4e2ef303315bdc5b0ef219ba66931d38b0330dd8a1`.
A real adapter executes that mounted script, creates the sibling
`tools/candidate.sh`, and returns the script output and Git status. The baseline
raw result is exactly
`{"tool":"tool-ready\n","status":"?? tools/candidate.sh\n"}`. Thus the declared
path is executable and excluded literally, while the candidate's sibling
change remains visible. The retained artifact has mode 0700 and the original
verified bytes after the successful workspace is cleaned. The original source
stays clean and unchanged.

The independently captured fixture digest is
`6e12cda3f9e94a77b841d110f0b8fe1ea0d79a08e5f2ffe8b2b34c86df581c4a`, and
the raw-result digest is
`a96b5763f9f158619d2d2166676c47446a3cae1937a7ebccc8009ed5069e190e`.
The test in
[`run_repository/artifacts.rs`](../../crates/sevro/tests/run_repository/artifacts.rs)
asserts these literal values and public retained references without production
hash helpers.

`cargo test -p sevro --test run_repository artifacts::executes_a_git_excluded_artifact_without_hiding_candidate_changes --locked -- --exact`
passed on its first execution (1 passed, 8 filtered out). This is a
characterization check of the existing executable and Git-exclusion behavior;
no product change or observed red is claimed.

## Setup declaration boundary characterization

The unchanged TypeScript CLI establishes twelve public refusal cases:

| Declaration                             | Exit | Diagnostic message                            |
| --------------------------------------- | ---- | --------------------------------------------- |
| Relative command executable             | 64   | `invalid fixture setup command`               |
| NUL in a command argument               | 64   | `invalid fixture setup command`               |
| Command exceeding 64 KiB                | 64   | `invalid fixture setup command`               |
| Reserved `PATH` environment name        | 64   | `invalid fixture setup environment`           |
| Lowercase environment name              | 64   | `invalid fixture setup environment`           |
| Hyphen in an environment name           | 64   | `invalid fixture setup environment`           |
| NUL in an environment value             | 64   | `invalid fixture setup environment`           |
| Unknown symbolic placeholder            | 64   | `invalid fixture setup environment`           |
| More than 32 environment entries        | 64   | `invalid fixture setup environment`           |
| Serialized environment exceeding 16 KiB | 64   | `invalid fixture setup environment`           |
| Setup with an inline fixture            | 64   | `fixture setup requires a Git fixture`        |
| Setup capability not negotiated         | 64   | `fixture setup capability was not negotiated` |

All use `sevro.invocation.invalid`, null run/evidence paths, empty cases, and
`not_run/not_requested/not_assessed`, with no host invocation or source
mutation. A separate success case passes `A0_B=literal $HOME` and uses setup to
verify that the value stays literal. Its dry run succeeds and retains evidence
without calling the native host.

The two tests in
[`run_repository/setup.rs`](../../crates/sevro/tests/run_repository/setup.rs)
passed on their first execution with
`cargo test -p sevro --test run_repository setup:: --locked`
(2 passed, 9 filtered out). They characterize existing public validation and
environment behavior; no product changes or observed reds are claimed.

## Setup cancellation retains the actual admitted trial

The baseline setup starts a real descendant that would write a project marker
after two seconds. It first publishes its process IDs, private HOME, and actual
working directory to a controlled readiness file. After readiness, the test
sends SIGINT or SIGTERM to the CLI itself. The unchanged TypeScript command
returns 130 or 143 respectively with `cancelled/not_requested/not_assessed`
and diagnostic `sevro.run.cancelled: run cancelled`. The public trial retains
its actual cloned workspace, has null candidate duration and raw-result path,
and marks final observations unavailable. The private setup HOME is removed,
the descendant never writes its delayed marker, the native host never starts,
and the original source remains unchanged.

The durable
[`cancels_setup_descendants_and_retains_the_admitted_trial`](../../crates/sevro/tests/run_repository/setup.rs)
test covers both signals through the compiled CLI. It reads the retained
workspace from public evidence, compares it with the setup-reported working
directory, and checks the cloned README bytes. Its readiness file describes
real processes and filesystem state; it does not fabricate an owner checkpoint
or retained result.

Red — `cargo test -p sevro --test run_repository setup::cancels_setup_descendants_and_retains_the_admitted_trial --locked -- --exact`:
the command compiled and produced cancelled evidence, but the real setup
descendant survived SIGINT and wrote its delayed marker. The focused test
failed with `setup descendant survived SIGINT`.

Green — `cargo test -p sevro --test run_repository setup::cancels_setup_descendants_and_retains_the_admitted_trial --locked -- --exact`:
passed (1 passed, 11 filtered out) after passing the invocation's shared
cancellation signal into fixture materialization and setup. Setup returns a
typed cancelled outcome, terminates its actual process group, and removes its
private HOME. The core lifecycle retains that actual partial workspace and
skips the candidate. Ordinary setup failures still clean their workspace and
return their original error.

At this checkpoint, `cargo test -p sevro --test run_repository --locked`
passed all 12 tests. Scoped rustfmt, ledger Prettier formatting,
`bun run check:docs`, and
`cargo clippy --workspace --all-targets --locked -- -D warnings` passed.
No fixture behavioral red remains pending. Artifact source references,
repository staging/commits, generated fixtures, setup timeout parity, and
ownership recovery remain outside this checkpoint's demonstrated behavior.

## Repository source selection and whole-map validation

The unchanged TypeScript CLI rejects an empty source map with exit 64 and
`repository source reference is not declared`. The public result has null
run/evidence paths, empty cases, and `not_run/not_requested/not_assessed`.

Red — `cargo test -p sevro --test run_repository boundaries::refuses_an_undeclared_repository_reference --locked -- --exact`:
the Rust result used `repository source ref is not declared`, differing from the
baseline diagnostic. Green — the identical command passed (1 passed, 12
filtered out) after correcting that message. Source README bytes and clean Git
status remain unchanged and the native host is never invoked.

The next baseline supplies null, an array, a numeric mapping value, an HTTPS
mapping, or a valid selected repository accompanied by an unused HTTPS mapping.
All five return exit 64 with `case source map must contain file URLs` and the
same empty public failure shape. Validation covers every mapping, including
unselected references.

Red — `cargo test -p sevro --test run_repository boundaries::validates_the_entire_source_map_as_file_urls --locked -- --exact`:
the first input returned an implementation-specific deserialization diagnostic
instead of the baseline message. Green — the identical command passed
(1 passed, 13 filtered out) after introducing whole-map loading and validation
before fixture selection. The fixture resolver consumes that validated map;
its duplicate URL-prefix check was removed while real URL parsing and
canonical-path containment remain. An initial test compilation error from
serializing a URL directly was fixed before the behavioral red and is not
counted as red evidence.

## Real repository source failure characterization

Separate baseline invocations establish these public exit-64 diagnostics:

| Selected source                                      | Diagnostic message                                |
| ---------------------------------------------------- | ------------------------------------------------- |
| A regular file or missing path                       | `repository source is unreadable`                 |
| A plain directory or Git repository without a commit | `repository fixture Git operation failed`         |
| An existing subdirectory of a committed repository   | `repository source must name the repository root` |

`cargo test -p sevro --test run_repository boundaries::requires_a_readable_committed_repository_root --locked -- --exact`
passed on its first execution (1 passed, 14 filtered out). It asserts the full
public failure, unchanged source bytes and clean Git state, and absent host
execution for all five inputs. No product change or observed red is claimed.

Another baseline uses 1,024 real untracked files with 69-character names. Git
emits 74,752 bytes of status output, exceeding the 64 KiB limit. The CLI returns
exit 64 with `repository fixture Git output is too large` and no retained run.
`cargo test -p sevro --test run_repository boundaries::bounds_real_repository_status_output_without_mutating_source_files --locked -- --exact`
passed on its first execution (1 passed, 15 filtered out). It compares the
original and final real Git status, reads every unchanged sentinel file, and
requires no native invocation. This is a bounded-output characterization using
real Git, without replacement executables or fabricated process output.

## Overlay declaration boundary diagnostics

The baseline extension resolves repository overlays containing a case-variant
`.git/config`, an empty path, backslash or colon, an absolute path, an empty,
dot, or parent component, case-equivalent paths, either parent/child collision
ordering, or 1,025 files. Each returns exit 64 with the diagnostic wrapper
`invalid resolved case file: fixture: DETAIL; correct the fixture declaration`.
The details are respectively `repository fixture cannot write repository metadata`,
`invalid fixture path: PATH`, `repository fixture overlay paths collide`, or
`repository fixture exceeds the file limit`.

Red — `cargo test -p sevro --test run_repository overlay::rejects_unsafe_colliding_or_excessive_overlay_paths --locked -- --exact`:
the first metadata-path case returned only its inner diagnostic instead of the
baseline resolved-case diagnostic. Green — the identical command passed
(1 passed, 16 filtered out) after moving the existing overlay validation into
resolved-case preparation and retaining its complete diagnostic. This also
places validation before the extension's preparation request; fixture
materialization consumes the already validated declaration. An initial local
toolchain environment typo prevented Cargo from starting and is not counted as
a behavioral red.

All twelve inputs in
[`run_repository/overlay.rs`](../../crates/sevro/tests/run_repository/overlay.rs)
assert the complete public failure, untouched original README, clean source
status, and absent native invocation. The path/limit defenses already existed;
the observed regression concerned their preparation boundary and diagnostic.

The final combined command
`cargo test -p sevro --test run_repository --test run_dry --test run_extension --locked`
passed all 38 tests: 17 repository, 1 inline dry-run, and 20 extension tests.
Scoped rustfmt, ledger Prettier, documentation checks, and strict workspace
Clippy passed. A concurrent native constructor signature change briefly
prevented compilation; the core owner repaired that call site before the
unchanged verification commands passed. No fixture behavioral red remains.

These cases do not establish source-change race handling, the clone-revision
mismatch guard, or operating-system pipe/read failures. Such paths retain their
defenses without fabricated Git output or artificial ownership state. The
32 MiB overlay limit, direct-case validation breadth, artifact source references,
generated fixtures, staging/commits, and setup deadline remain separate public
acceptance work; no valid unported grader selection was asserted as a permanent
refusal.

## Present-null source reference in a direct case file

Read-only baseline preparation captured 79 independent TypeScript direct-case
invocations, then compared the existing Rust executable separately. Those
experimental comparisons identify future work; they are not durable TDD reds.
The first selected case has id `direct-case`, prompt `Return ready.`, fixture
`{"sourceRef":null,"files":{}}`, one exact-output check for `ready`, and no
required evidence. The TypeScript CLI returns exit 64 with null run/evidence,
empty cases, `not_run/not_requested/not_assessed`, and this diagnostic, where
`PATH` is the selected case file's absolute path:

```text
resolved case file is unreadable or invalid at PATH: invalid resolved case file: fixture: invalid repository fixture; correct the fixture declaration; supply --case-file with readable JSON and correct the named field
```

The durable test in
[`run_repository/preparation.rs`](../../crates/sevro/tests/run_repository/preparation.rs)
asserts the entire public result, absence of native invocation, unchanged source
README bytes, and clean Git status.

Red — `cargo test -p sevro --test run_repository preparation::rejects_a_present_null_repository_source_reference --locked -- --exact`:
the compiled Rust CLI returned exit 0 and retained a successful dry run because
deserializing `Option<String>` treated present-null `sourceRef` as absent.
Green — the identical command passed (1 passed, 17 filtered out) after inspecting
that property at the raw direct-file boundary before typed conversion and
returning the baseline file diagnostic.

This bounded change leaves extension conversion behind its existing validated
protocol boundary. The published extension case schema cannot be applied
unchanged to direct files: it requires `extensionData` and explicit fixture kinds,
while the direct baseline omits them; it also rejects some direct-file inputs
the baseline accepts. The rest of the experimental matrix remains separate
acceptance work, including explicit-null follow-up, direct fixture kind rules,
required-evidence ID validation, and diagnostic ordering.

`cargo test -p sevro --test run_repository --test run_dry --locked` passed all
19 tests (18 repository and 1 inline dry-run). Strict workspace Clippy, scoped
rustfmt, ledger Prettier, and documentation checks passed. The earlier
checkpoint-4 coverage measurement describes the frozen candidate before this
change; it is not coverage evidence for this later fix. No further matrix cases
were added to the durable suite in this slice.

## Finite direct-case acceptance mismatches

The next five successive slices use the same independently captured direct-file
matrix. Each test was added only after the preceding slice passed. Every listed
command compiled, observed the stated behavioral failure, and then passed
unchanged after its bounded repair:

| Focused command                                                                                                                                       | Observed red                                                                    | Green behavior                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test -p sevro --test run_repository preparation::rejects_a_present_null_follow_up_prompt --locked -- --exact`                                  | Rust accepted null and returned 0 instead of 64.                                | Explicit null produces the baseline `followUpPrompt: omit or supply a nonblank string` detail inside the actionable direct-file diagnostic.               |
| `cargo test -p sevro --test run_repository preparation::rejects_invalid_required_evidence_identifiers --locked -- --exact`                            | Rust accepted an empty required-evidence ID and returned 0 instead of 64.       | Both empty and unnamespaced IDs return 64 `invalid required evidence IDs`.                                                                                |
| `cargo test -p sevro --test run_repository preparation::rejects_duplicate_required_evidence_identifiers --locked -- --exact`                          | Rust accepted the duplicated `example.receipt` ID and returned 0 instead of 64. | Duplicates return 64 `invalid required evidence IDs`.                                                                                                     |
| `cargo test -p sevro --test run_repository preparation::rejects_kind_tags_in_direct_inline_or_repository_cases --locked -- --exact`                   | Rust accepted a direct inline kind tag and returned 0 instead of 64.            | Explicit inline, repository, and null kinds return the baseline direct-file detail `fixture.kind: omit for inline/repository fixtures, or use generated`. |
| `cargo test -p sevro --test run_repository preparation::accepts_extra_direct_inline_properties_without_changing_fixture_identity --locked -- --exact` | Rust rejected the extra inline property `unused` with 64 instead of succeeding. | A direct inline fixture with empty files and `unused:true` succeeds; the extra property does not enter materialization or fixture identity.               |

All refusal tests assert complete public failure results, no native invocation,
unchanged source README bytes, and clean Git status. The accepted-inline test
also asserts dry states, the retained result, cleanup of the actual workspace
named by public evidence, and these literal baseline identity dimensions:

| Dimension       | Baseline value                                                     |
| --------------- | ------------------------------------------------------------------ |
| `caseDigest`    | `4f0ebf312483328e3bf31a35f318b16f22bc1c1ac7f420bba0cb045dfb9fed0a` |
| `fixtureDigest` | `fc1f5d14b99603011b03d4001fe6fe3b9062e39ea6c25fca4782b0d1022e428c` |

Required-evidence validation uses the TypeScript namespaced pattern and
uniqueness rule. It does not impose the extension schema's additional ID-length
limit. Direct-file presence checks share one diagnostic wrapper after the
focused greens; extension parsing continues to accept its negotiated kind-tagged
shape behind the existing protocol schema. Inline-only extra properties are
discarded at the direct-file boundary without loosening repository or extension
declarations. The six direct preparation tests, including the prior null-source
case, passed together after that refactor.

The finite set now has **9 of 10 exit mismatches resolved**. A separate rerun of
the ten saved inputs also matches the baseline execution/grading/task states
and diagnostics for those nine. The unresolved case is NUL in an inline file
path: TypeScript returns 70 after materialization reaches the filesystem and
reports its actual temporary path; Rust rejects the declaration earlier with 64. This remains port work, not a compatibility pass. No shared containment
guard or fixture materializer was changed for that case, and no passing durable
test is claimed for it. Its original raw baseline is retained outside the
checkout at:

```text
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-direct-case-baseline-e17kxm6_/typescript/inline-path-nul.stdout
```

The same directory retains `typescript-baselines.json`, the pre-change
`comparison.json`, and the later `finite-matrix-after.json`; these experimental
files do not replace the recorded durable red/green commands.

At the hold point,
`cargo test -p sevro --test run_repository --test run_dry --locked` passed all
28 tests: 27 repository tests, including the separate artifact owner's four
new boundary tests, and 1 inline dry-run test. Strict workspace Clippy, scoped
rustfmt, ledger Prettier, and documentation checks passed. No durable test is
left red. The NUL-path mismatch and the wider diagnostic-only matrix remain
explicitly outside this completed finite repair set.

## Four direct-file validation diagnostics

Four successive public CLI slices use the saved independent TypeScript cases
`id-empty`, `checks-missing`, `check-configuration-null`, and `checks-duplicate`
from `sevro-direct-case-baseline-e17kxm6_`. Each new test was written only after
the preceding slice passed. These are diagnostic repairs for already-rejected
inputs, not new fixture or grader features. The refusal assertions compare the
entire public result: exit 64, `sevro.invocation.invalid`, null run/evidence,
empty cases, and `not_run/not_requested/not_assessed`. They also require no
native invocation, unchanged source README bytes, and clean source Git status.

Red — `cargo test -p sevro --test run_repository preparation::rejects_an_empty_case_id_but_accepts_a_whitespace_id --locked -- --exact`:
the CLI returned `case id and prompt must be nonempty strings` instead of the
direct-file diagnostic naming `id: expected a nonempty string`.
Green — `cargo test -p sevro --test run_repository preparation::rejects_an_empty_case_id_but_accepts_a_whitespace_id --locked -- --exact`:
1 passed. The same test also preserves the independently observed accepted
single-space ID, successful dry states, unchanged public case ID, and absent
native invocation.

Red — `cargo test -p sevro --test run_repository preparation::names_the_missing_checks_field_in_a_direct_case --locked -- --exact`:
the CLI returned the serde error ``invalid case file: missing field `checks` ``
instead of naming `checks: expected an array of check objects`.
Green — `cargo test -p sevro --test run_repository preparation::names_the_missing_checks_field_in_a_direct_case --locked -- --exact`:
1 passed with the baseline direct-file diagnostic.

Red — `cargo test -p sevro --test run_repository preparation::names_a_null_check_configuration_in_a_direct_case --locked -- --exact`:
the CLI returned `invalid case file: invalid type: null, expected a map` instead
of naming `checks[0].configuration: expected an object`.
Green — `cargo test -p sevro --test run_repository preparation::names_a_null_check_configuration_in_a_direct_case --locked -- --exact`:
1 passed with the actual check index in the baseline direct-file diagnostic.

Red — `cargo test -p sevro --test run_repository preparation::rejects_duplicate_check_ids_with_the_case_diagnostic --locked -- --exact`:
the CLI returned `check ids must be nonempty and unique` instead of the bare
semantic diagnostic `case check IDs must be unique`.
Green — `cargo test -p sevro --test run_repository preparation::rejects_duplicate_check_ids_with_the_case_diagnostic --locked -- --exact`:
1 passed. An intervening shell invocation omitted the toolchain `PATH` and did
not start Cargo; it is not counted as a behavioral test result.

For the first three cases, the full baseline wrapper is:

```text
resolved case file is unreadable or invalid at PATH: invalid resolved case file: ISSUE; supply --case-file with readable JSON and correct the named field
```

`PATH` is the actual selected case file and `ISSUE` is the field detail above.
The ordered direct-file checks run before typed conversion; extension cases
continue through their existing schema boundary. No extension schema was
applied wholesale to direct files. Other malformed shapes and multiple-error
combinations in the captured matrix remain separate acceptance work; these four
tests do not establish complete diagnostic parity. The deferred NUL-path
materialization mismatch remains unchanged.

The combined regression command
`cargo test -p sevro --test run_repository --test run_dry --test run_extension --locked`
passed all 53 tests: 32 repository, 1 inline dry-run, and 20 extension tests.
The repository count includes the separate artifact owner's source-reference
success test. Scoped rustfmt and documentation checks passed. A strict Clippy
attempt found temporarily unread observation fields during concurrent core
integration; no fixture code or lint suppression was changed for that failure.
After the core owner completed that integration,
`cargo clippy --workspace --all-targets --locked -- -D warnings` passed unchanged.
Ledger Prettier and documentation checks passed at the hold point. No intentional
red remains in this four-case set.

## Nested overlays, exact byte limit, and occupied targets

The next finite cohort exercises the real CLI with clean committed repositories.
Existing tests already cover README replacement, source/index preservation,
symlink parents, and invalid path/count declarations. The new success case adds
two missing parent directories: negotiated setup reads `new/deep/note.txt` and
a shorter replacement README, then verifies the original committed README.
The actual source repository remains unchanged. Successful dry evidence names
a workspace that has been removed after completion.

Before each durable test, the unchanged TypeScript CLI produced the independent
oracle outside the checkout. These directories retain exact invocations, raw
stdout/stderr, source hashes, and summaries:

```text
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-overlay-nested-baseline-espo8_3a
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-overlay-byte-bound-baseline-zxu7io6s
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-overlay-directory-baseline-1mn94ykl
```

Initial-green characterization — `cargo test -p sevro --test run_repository overlay::creates_nested_repository_overlay_paths_before_setup --locked -- --exact`:
1 passed without a product edit. Trusted setup consumes both overlay files;
the public fixture digest is
`5c3a4f327a536468be51ac1787b8d68b107874576157c93059cbc2ef865fea7c`
and its setup digest is
`dfbbde8d7e6ec04ad1ff0e46c794905b9ec7bebbe90912d978bde41d5a681eb9`.

Initial-green characterization — `cargo test -p sevro --test run_repository overlay::accepts_repository_overlay_at_the_exact_utf8_byte_limit --locked -- --exact`:
1 passed without a product edit. The direct case contains 33,554,420 ASCII
content bytes at `données.txt`, whose UTF-8 path consumes 12 bytes. The total is
exactly 33,554,432 bytes (32 MiB). The successful public fixture digest is the
literal baseline value
`749324f55f7497b8d2b2229ad3eaa21dd96478bc47359fd78eb647621bf8f338`.
This uses `--case-file`; the extension wire bound cannot carry this declaration.

Red — `cargo test -p sevro --test run_repository overlay::rejects_the_next_overlay_byte_including_utf8_path_bytes --locked -- --exact`:
33,554,421 content bytes plus the same path were correctly rejected with 64,
but the Rust diagnostic omitted the direct case file path and correction
guidance. The observed TypeScript result has null run/evidence, empty cases,
`not_run/not_requested/not_assessed`, `sevro.invocation.invalid`, and:

```text
resolved case file is unreadable or invalid at PATH: invalid resolved case file: fixture: repository fixture exceeds the size limit; correct the fixture declaration; supply --case-file with readable JSON and correct the named field
```

Green — `cargo test -p sevro --test run_repository overlay::rejects_the_next_overlay_byte_including_utf8_path_bytes --locked -- --exact`:
1 passed after retaining optional direct-file path context during preparation.
Only repository declaration errors use that context; the extension entrypoint
keeps its existing wording, and grader configuration validation is unchanged.
The fix does not parse diagnostic strings or change overlay limits.

Initial-green characterization — `cargo test -p sevro --test run_repository overlay::refuses_an_existing_directory_as_the_final_overlay_target --locked -- --exact`:
1 passed without a product edit. A declared overlay targets an existing
directory containing a committed file. Both CLIs return 70
`repository fixture overlay targets a non-file`, with null run/evidence and
unchanged source directory, sentinel bytes, README, HEAD, and Git status. The
test asserts the entire public failure and absence of native invocation.

Failed materialization now retains its workspace through the separate setup
deadline repair. Public owner/checkpoint discovery for that reserved workspace
is still unported. The final-target test therefore has a cleanup-only guard:
a fresh sentinel filename and random value are committed to its source, and the
guard removes only its matching retained clone. It requires an owned private
namespace, non-symlink owned directory entries, and a regular sentinel opened
without following links whose complete bytes match. It never removes the
namespace or unmatched entries. No acceptance assertion depends on this private
allocation layout, and no owner/checkpoint state is fabricated.

At this cohort's hold point, the focused commands passed:

- `cargo test -p sevro --test run_repository overlay:: --locked`: 5 passed.
- `cargo test -p sevro --test run_repository preparation:: --locked`: 10 passed.
- `cargo test -p sevro --test run_dry --test run_extension --test run_graders --locked`:
  43 passed (1 dry, 20 extension, 22 grader).
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed.
- Scoped rustfmt, ledger Prettier, and `bun run check:docs`: passed.

The 58 passing tests are focused regression evidence; the coordinator owns the
next complete frozen-candidate checkpoint, including the real setup deadline.
No product change was needed in repository overlay validation/materialization.
The only product repair in this cohort is the direct-file diagnostic context in
preparation. No intentional red remains, and generated fixtures remain deferred.

## Native isolation for mapped repository worktrees

This single repair follows the existing public CLI isolation scenario
`CLI isolates mapped repository worktrees for ${route} execution` in
`tests/cli/fixture-preparation.test.ts`. The
[runtime contract](../runtime-v1.md#environment-and-host-tools) protects source and configuration
worktrees, and the [fixture parity specification](rust-fixtures-graders-parity.md)
requires the mapped repository, its primary checkout, and linked peers to remain
unreadable while the cloned fixture remains usable.

An independent reduced TypeScript CLI invocation and the frozen checkpoint 6
Rust executable used the same real temporary Git repository and linked
worktrees. The declared source container held the mapped worktree; the native
wrapper's directory held a sibling worktree. The wrapper ran actual Codex
sandbox commands, read a committed fake marker from the clone, and attempted
the same read from all three source worktrees. It returned `ready` only when
all source reads were denied. The ordinary `sevro.output` check consumed that
response. No authenticated model request, shell grader, semantic grader, or
advisory route was involved.

The experiment used macOS and Codex CLI 0.163.0. TypeScript returned 0 with
`completed/completed/passed`: the clone was readable, and primary, mapped, and
sibling sources were denied. Frozen Rust returned 1 with
`completed/completed/failed`: the sibling's exact fake marker was readable.
All three source worktrees retained their original marker, HEAD, and clean Git
status. Exact commands, stdout/stderr, probe results, evidence copies, binary
hash, and source hashes are retained at:

```text
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-mapped-worktree-isolation-p8itnsz6/summary.json
```

The standalone experiment script is `/tmp/sevro-mapped-worktree-isolation.py`.
The frozen binary was
`/tmp/sevro-rust-core-snapshot.x3psmgs6/target-stable-coverage/debug/sevro`, with
SHA-256 `fadb33266750c8ba39e2bfbe6972bd88c6c094c0eb922a16b2459bb9d10f16b6`.
Its coverage output was redirected into the experiment directory; checkpoint 6
coverage remains evidence for the earlier candidate.

Red — `cargo test -p sevro --test run_repository isolation::protects_mapped_repository_linked_worktrees_from_native_commands --locked -- --exact`:
the durable test compiled and failed against unchanged current product behavior.
The CLI returned 1 instead of 0, and the actual sandbox probe reported
`sibling readable OWNED_MAPPED_WORKTREE_MARKER`. Clone access succeeded,
primary/mapped reads were denied, and all source bytes, HEADs, and Git statuses
were unchanged. This reproduces the frozen candidate's behavior through the
public CLI, rather than substituting the earlier experiment for a real red.

Green — `cargo test -p sevro --test run_repository isolation::protects_mapped_repository_linked_worktrees_from_native_commands --locked -- --exact`:
1 passed after the two-file fixture repair. `RepositorySource` now supplies both
its declared source container and actual canonical mapped repository path;
`PreparedFixture` forwards both. The existing native worktree expansion can
therefore discover the primary and sibling checkouts. The previous container
protection remains. No native host, profile, preparation, or grader source
changed. The test proves clone access, actual denial of all three source reads,
public success, and unchanged source content and Git state.

The test owns its entire temporary project, source worktrees, fake authentication,
wrapper, and `TMPDIR`; cleanup removes only that owned root. The independent
experiment remains outside the checkout for review. This local result covers
the candidate Codex route on macOS; the durable test also provisions the existing
Linux sandbox helper for the supported CI platform.

At the slice's hold point, the affected checks passed:

- `cargo test -p sevro --test run_repository --locked`: 44 passed, including the
  real two-minute setup deadline and its descendant-cleanup assertion.
- `cargo test -p sevro --test run_native_codex isolates_protected_linked_git_worktrees --locked -- --exact`:
  1 passed.
- `cargo test -p sevro --test run_native_codex executes_isolated_codex_turn --locked -- --exact`:
  1 passed.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed.
- Scoped rustfmt, ledger Prettier, and `bun run check:docs`: passed.

The full native suite remained with its active owner; the two existing exact
controls avoid treating an evolving test count as a frozen result. A full
`cargo fmt --all -- --check` attempt reported formatting drift only in that
owner's in-progress `tests/native_codex/continuation_evidence.rs` and the options
owner's `tests/run_options.rs`. Neither file was edited here, and both owners
were notified. The coordinator owns the combined candidate's final formatting
and coverage gate. No intentional red remains in this isolation slice.

## Direct prompt, check, and inline declaration diagnostics

This bounded cohort follows checkpoint 7's preparation diagnosis. Before adding
tests, 24 actual invocations of the unchanged TypeScript CLI captured direct
prompt, follow-up, check, and fixture declaration behavior. The commands use
`run --json --dry`, a real clean declared repository, fake authentication, and
an executable invocation marker. The marker remained absent and the source
remained clean. Inputs, full commands, stdout/stderr, public results, and
TypeScript source hashes are retained at:

```text
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-preparation-edges-baseline-d3i1sfab/summary.json
```

The script is `/tmp/sevro-preparation-edges-baseline.py`. The independent sources
are `src/case-validation.ts`, `src/cli/loading.ts`,
`src/evaluation/check-plan.ts`, and `src/graders/output.ts`. Direct files keep
their existing accepted shape; the extension schema is not applied to them.

The final eight new public tests cover 19 of those captured inputs. Eighteen
are refused with 64, `sevro.invocation.invalid`, null run/evidence paths, empty
cases, and `not_run/not_requested/not_assessed`. A whitespace-only primary
prompt is accepted with successful dry evidence. All refusals assert the full
public result, absence of native invocation, and unchanged declared source.

Red — `cargo test -p sevro --test run_repository preparation_edges::names_a_missing_prompt_before_malformed_fixture_fields --locked -- --exact`:
Rust returned the serde message ``invalid case file: missing field `prompt` ``
instead of the direct-file diagnostic naming `prompt: expected a nonempty
string`.

Green — `cargo test -p sevro --test run_repository preparation_edges::names_a_missing_prompt_before_malformed_fixture_fields --locked -- --exact`:
1 passed. The direct boundary now validates the prompt before the fixture,
including when the same case also contains a null fixture.

Initial-green characterization — `cargo test -p sevro --test run_repository preparation_edges::requires_a_nonempty_prompt_but_accepts_whitespace --locked -- --exact`:
1 passed after the preceding prompt repair, without another product edit. Empty,
null, and numeric prompts have the same named-field diagnostic; a single-space
prompt is accepted. This is not a separate claimed red.

Red — `cargo test -p sevro --test run_repository preparation_edges::names_blank_or_nonstring_follow_up_prompts --locked -- --exact`:
Rust returned `followUpPrompt must be a nonblank string` without the direct-file
wrapper and guidance.

Green — `cargo test -p sevro --test run_repository preparation_edges::names_blank_or_nonstring_follow_up_prompts --locked -- --exact`:
1 passed. Empty, space/tab-only, and numeric follow-up prompts now name
`followUpPrompt: omit or supply a nonblank string` at the direct-file boundary.
The existing extension-side semantic check remains.

Red — `cargo test -p sevro --test run_repository preparation_edges::names_an_empty_output_check_id --locked -- --exact`:
Rust returned `check ids must be nonempty and unique`.

Green — `cargo test -p sevro --test run_repository preparation_edges::names_an_empty_output_check_id --locked -- --exact`:
1 passed with the exact baseline message `duplicate or empty check ID: `,
including its trailing space. The duplicate-ID diagnostic remains separate.

Red — `cargo test -p sevro --test run_repository preparation_edges::refuses_a_direct_case_without_its_requested_extension_grader --locked -- --exact`:
Rust returned `grader preparation is not yet supported in Rust: example.missing`.

Green — `cargo test -p sevro --test run_repository preparation_edges::refuses_a_direct_case_without_its_requested_extension_grader --locked -- --exact`:
1 passed. A direct case requesting `example.missing` or an empty grader now
returns `case declares an unavailable extension grader`. This repair only
classifies unavailable direct-case extension graders. Existing built-in graders
remain distinct; no test cements an unported built-in refusal as compatibility.

Red — `cargo test -p sevro --test run_repository preparation_edges::names_a_missing_or_nonobject_fixture --locked -- --exact`:
Rust returned the serde message ``invalid case file: missing field `fixture` ``.

Green — `cargo test -p sevro --test run_repository preparation_edges::names_a_missing_or_nonobject_fixture --locked -- --exact`:
1 passed. Missing, null, and array fixtures now name `fixture: expected an
object` inside the direct-file wrapper.

Red — `cargo test -p sevro --test run_repository preparation_edges::names_a_missing_or_nonobject_inline_file_map --locked -- --exact`:
Rust returned `invalid case file: inline fixture requires files`.

Green — `cargo test -p sevro --test run_repository preparation_edges::names_a_missing_or_nonobject_inline_file_map --locked -- --exact`:
1 passed. Missing, null, and array inline file maps now name `fixture.files:
expected an object mapping file paths to string contents`. This check applies
only when the direct fixture declares neither kind nor source reference.

Red — `cargo test -p sevro --test run_repository preparation_edges::names_the_inline_file_with_nonstring_contents --locked -- --exact`:
Rust returned ``invalid case file: invalid type: integer `7`, expected a string``.

Green — `cargo test -p sevro --test run_repository preparation_edges::names_the_inline_file_with_nonstring_contents --locked -- --exact`:
1 passed with `fixture.files["README.md"]: expected string contents` inside the
direct-file wrapper. The identical green command waited for the shared Cargo
build lock before compiling and completing; that wait is not a test failure.

The cohort closes at seven genuine red/green slices and one initial-green
characterization. No guards were deleted, no JSON-pointer policy changed, and
the extension/setup/artifact ownership boundary was preserved. The five other
captured inputs remain deferred: empty/numeric repository source references,
explicit inline kind combined with sourceRef, and two malformed generated
declarations. They are investigation evidence, not new durable tests or claimed
compatibility. Generated fixture implementation remains separate work.

The coordinator paused new test processes after the last green because shared
commands were stalling. No further runtime suite was launched under that hold.
`preparation.rs` is released to the grader owner after scoped formatting; the
final affected regression checks will run only after a scheduling slot opens.

## Local tool environment

Commands use the pinned Rust toolchain with these existing local locations:

```sh
export RUSTUP_HOME=/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain/rustup
export CARGO_HOME=/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain/cargo
export PATH="$CARGO_HOME/bin:$PATH"
```

The commands are routed through `lean-ctx -c`. An initial shell attempt without
that environment could not find Cargo; that environment failure is not counted
as red evidence. The recorded behavioral red above compiled and ran the real
test successfully before reporting the expected missing feature.
