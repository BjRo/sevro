# Rust provenance TDD evidence

The public seam is `sevro run --json --dry` and its retained v1 evidence.
Project identity follows the [identity contract](../identity-v1.md) and the
I06–I10 [parity requirements](rust-protocol-results-parity.md#canonical-identity-and-provenance).
Tests spawn the actual Rust executable with a real filesystem project and
explicit synthetic native prerequisites. No model execution is needed.

The commands below run from the worktree root with Rust 1.99.0 through
`lean-ctx -c`. `RUSTUP_HOME` and `CARGO_HOME` select the discovered toolchain
under `/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain`.

## Default non-Git project identity

The independent oracle came from the unchanged TypeScript CLI over a project
containing only mode-0600 `README.md` with bytes `alpha\n`. Inputs and synthetic
credentials were outside the evaluated project, with selected results under
`project/results`. Two actual dry CLI runs returned project digest
`858d75592df9d4eb600d72b50440c1ca4be9eecd1a8cb7944cd92a6d1b74334f`, null
revision/dirty provenance, and the caller's explicit runner digest. Thus the
second run's stored output did not become project content.

- Red — `cargo test -p sevro --test run_provenance derives_non_git_project_identity_without_a_digest_override -- --exact`:
  the compiled CLI returned 64 with `missing --project-digest` instead of
  deriving the project identity and completing dry preparation.
- Green — `cargo test -p sevro --test run_provenance derives_non_git_project_identity_without_a_digest_override -- --exact`:
  one test passed after making the project override optional, resolving actual
  non-Git provenance, and hashing the bounded sorted file snapshot. Both dry
  runs retain the literal independently observed digest, the selected absolute
  project URL and null Git provenance; the original file remains unchanged.

This slice still supplies an explicit runner digest. The coordinator owns
combined quality checks and exact-commit CI.

## Git content provenance

The unchanged TypeScript CLI established literal vectors in a real temporary
Git repository with a fixed fixture commit
`118e3a42e2d7a59b599d2415e33d4a8e2a36e9a1`. Its sole tracked file was mode-0600
`README.md` containing `alpha\n`. The clean project digest was
`686e923b8f017cb31a9d9adae45155d0ef045e76ddc8fd991eb97648d9d50656`; a repeat
kept that value despite project-local results. Changing the file to `beta\n`
and then adding `new.txt` with `untracked\n` produced distinct, retained
literal dirty/project digest pairs. The test contains those expected values,
without recomputing the dirty-patch algorithm.

- Red — `cargo test -p sevro --test run_provenance git_project_identity_binds_revision_tracked_edits_and_untracked_content -- --exact`:
  the compiled CLI returned 64 with `Git project provenance is not yet implemented`.
- Green — `cargo test -p sevro --test run_provenance git_project_identity_binds_revision_tracked_edits_and_untracked_content -- --exact`:
  one test passed with exact clean, repeated, tracked-edit and untracked-content
  vectors. Every run retains the original revision; tracked changes remain
  included and only selected untracked output storage is excluded.

The implementation uses real Git commands in a reduced environment and checks
the discovered repository root, revision spelling and bounded dirty content.
Additional snapshot boundary cases remain separate slices.

## Standalone native build identity

The native build-input choice was explicitly authorized as the installed binary
plus shipped assets. The current standalone runtime's schemas, help, templates
and adapter bridge are embedded; its external-asset list is empty. The native
profile is documented separately from the historical TypeScript profile in the
[identity contract](../identity-v1.md).

The public test copies the built executable to a temporary consumer directory
without source Git or package assets. Python's independent `hashlib`/canonical
JSON receipt binds that installed file's actual bytes to the documented native
envelope; no Rust provenance helper computes the expected value. Both the
original and copied executable must retain that digest, package name/version,
and the independently fixed project identity without either digest override.

- Red — `cargo test -p sevro --test run_provenance standalone_runner_identity_binds_the_installed_binary_without_overrides -- --exact`:
  the CLI returned 64 with `missing --runner-build-digest` instead of deriving
  the actual running binary's build identity. Earlier attempts encountered an
  incorrect toolchain PATH and a concurrent native-host compile transition;
  neither is behavioral red evidence.
- Green — `cargo test -p sevro --test run_provenance standalone_runner_identity_binds_the_installed_binary_without_overrides -- --exact`:
  one test passed after making the override optional and streaming the current
  executable's bytes into the documented identity profile. Relocation preserves
  the digest because neither executable nor checkout paths enter it.

The separately compiled npm-bundle profile and explicit checkout source-receipt
association are later slices; this test does not establish either behavior.

## Additional project characterizations

These public tests passed on first execution and required no product changes;
no red is claimed:

- `cargo test -p sevro --test run_provenance non_git_snapshot_ignores_location_and_time_but_tracks_content_and_execute_mode -- --exact`:
  relocation and modified timestamps preserve identity; changing bytes and
  then execute permission matches distinct literal TypeScript CLI vectors.
- `cargo test -p sevro --test run_provenance unborn_repositories_use_content_identity_while_corrupt_git_metadata_refuses -- --exact`:
  an unborn repository retains null revision/dirty provenance and the known
  content digest. Corrupt Git metadata refuses even with a digest override,
  leaves no successful evidence, and remains unchanged.
- `cargo test -p sevro --test run_provenance non_git_snapshot_refuses_symlinks_and_fifos_without_modifying_them -- --exact`:
  both entries refuse before successful evidence; their inode/mode and original
  project bytes remain intact.
- `cargo test -p sevro --test run_provenance non_git_snapshot_enforces_file_and_byte_limits_without_replacing_latest -- --exact`:
  exactly 4,096 files or 64 MiB succeeds; one additional file or byte refuses
  without replacing latest or modifying project content.
- `cargo test -p sevro --test run_provenance explicit_digest_overrides_take_priority_without_replacing_real_git_provenance -- --exact`:
  the final supplied runner digest and explicit project digest take priority,
  while real revision and dirty-patch provenance remain intact. An earlier
  concurrent fixture API compilation failure was not behavioral red.
- `cargo test -p sevro --test run_provenance unicode_project_paths_match_the_existing_utf16_ordering_vectors -- --exact`:
  `😀.txt` and U+E000-prefixed filenames match literal independently observed
  TypeScript project/dirty digests for both non-Git and Git projects. The test
  does not recompute Rust's ordering or hashing algorithm.
- `cargo test -p sevro --test run_provenance tracked_files_inside_selected_storage_still_change_git_identity -- --exact`:
  selected untracked results stay excluded; editing a tracked file inside that
  same storage directory still changes dirty/project identity.
- `cargo test -p sevro --test run_provenance untracked_git_symlinks_hash_the_target_text_without_following_it -- --exact`:
  Rust matches complete TypeScript project provenance and digest over the same
  public fixture. Changing the outside referent's bytes has no effect; changing
  link target text changes identity, including a dangling target.

The now-unreachable placeholder checkout field/guard was removed from the private
request while checkout association is not exposed. No private-input test was
invented to cover it; the three implementation tests passed after the refactor.

## Identity derivation error categories

The oversized-Git test initially assumed exit 64 for the reference CLI. Its
first baseline invocation instead returned 70 with `sevro.runner.error` and
`Git identity exceeds the size limit`; this was an incorrect test oracle, not
a Rust red. A separate unchanged TypeScript CLI invocation confirmed the result.
Automatic digest derivation happens before engine preparation. This checkpoint
incorrectly inferred that an explicit project override moved real Git provenance
inside a configuration-error wrapper. The later public worktree-redirection
case below retracts that inference: only runner provenance has that wrapper;
project provenance errors remain exit 70 with or without an override.

- Red — `cargo test -p sevro --test run_provenance oversized_git_patch_and_untracked_bytes_refuse_without_changing_the_project -- --exact`:
  after correcting the independent oracle, the reference CLI passed but Rust
  returned 64/`sevro.invocation.invalid` for the same oversized tracked patch,
  instead of exit 70.
- Green — `cargo test -p sevro --test run_provenance oversized_git_patch_and_untracked_bytes_refuse_without_changing_the_project -- --exact`:
  one test passed after preserving the error category through typed provenance
  and preparation errors. Both over-32-MiB tracked patches and untracked bytes
  refuse with exit 70, null evidence, unchanged revision/status/content and no
  created results.

The earlier non-Git symlink/FIFO and size-limit tests also initially asserted 64. Their refusal and preservation checks were already green, but that did not
establish exit-code parity. They now execute both public CLIs and require the
observed automatic-derivation exit 70. The original explicit-override corrupt-Git
test asserted Rust's exit 64 without a TypeScript invocation, so it did not
establish parity. That assertion is corrected below. Concurrent compile transitions while coordinating error
types are not counted as red/green observations.

## Filesystem and Git validation follow-up

`cargo test -p sevro --test run_provenance unreadable_project_files_and_directories_preserve_prior_evidence -- --exact`
passed on its first execution. Both public CLIs refuse mode-000 project files
and directories with exit 70 and null evidence; existing latest evidence,
permissions and content remain unchanged. No product change or red is claimed.

A real Git repository with `core.worktree` redirected to another existing
directory independently exposed the prior exit-code oracle error. The initial
test expected 64 when a project digest override was supplied; the TypeScript
CLI returned 70. Inspection of `src/evaluation/plan.ts` confirms that its
`projectProvenance` call is not wrapped as `EvaluationConfigurationError`.
The old phase-dependent project claim is retracted, rather than counted as
another successfully implemented behavior. Runner provenance remains distinct.

- Red — `cargo test -p sevro --test run_provenance redirected_git_worktree_refuses_even_with_digest_override -- --exact`:
  after correcting the independent oracle, TypeScript passed and Rust returned
  64 instead of 70 for the explicit-project-digest invocation.
- Green — `cargo test -p sevro --test run_provenance redirected_git_worktree_refuses_even_with_digest_override -- --exact`:
  one test passed after mapping project provenance failures to exit 70
  regardless of override presence. Both CLIs refuse the mismatched real Git
  root, leave metadata and the other worktree unchanged, and create no results.
- `cargo test -p sevro --test run_provenance unborn_repositories_use_content_identity_while_corrupt_git_metadata_refuses -- --exact`:
  passed after replacing the unsupported exit-64 assumption with actual
  TypeScript and Rust invocations, both requiring exit 70 for corrupt Git
  metadata even with an explicit project digest.

The following additional public characterizations required no product changes:

- `cargo test -p sevro --test run_provenance unreadable_git_metadata_and_untracked_files_refuse_without_changes -- --exact`:
  both CLIs return 70 for inaccessible Git metadata and unreadable untracked
  bytes without changing revision or content. Initial fixture attempts kept
  results and default runtime configuration beneath the inaccessible directory;
  the reference CLI correctly refused those earlier validation phases with 64.
  Selecting external results and a real explicit runtime configuration reached
  provenance and passed. Those fixture corrections are not behavioral reds.
- `cargo test -p sevro --test run_provenance untracked_nested_git_repository_refuses_without_reading_its_contents -- --exact`:
  first execution passed. Actual Git reports an untracked nested repository as
  `nested/`; both CLIs refuse that unsupported directory entry, preserve its
  content and metadata, and create no results.
- `cargo test -p sevro --test run_provenance git_uses_the_system_path_default_and_refuses_an_explicit_path_without_git -- --exact`:
  first execution passed. Both CLIs resolve real Git through the system default
  when PATH is absent and retain the fixed clean-project identity. An explicit
  empty executable directory refuses with 70 and null evidence.

Every provenance expected-failure assertion now runs the unchanged TypeScript
CLI as its independent baseline. Invalid revision spellings and unsafe
relative paths are not fabricated as Git output to cover defensive checks.
Race-only filesystem errors and the Linux temporary-placeholder handling remain
unmeasured by this macOS follow-up; no exclusions or counters were changed.

## Temporary Git metadata platform boundary

`cargo test -p sevro --test run_provenance temporary_git_metadata_is_ignored_only_for_an_empty_directory_on_linux -- --exact`
passed on its first macOS execution, before product changes. Each public CLI
receives an owned temporary ancestor through `TMPDIR`; its `.git` entry is an
empty directory, a nonempty directory, or a regular file. No global `/tmp/.git`
or other user's metadata is touched. The unchanged TypeScript CLI confirms
macOS refusal with exit 70 for all three forms; bytes and metadata remain intact.
The same public test requires Linux to ignore only the empty directory and
retain the fixed non-Git content identity. That Linux result awaits Ubuntu CI,
and is not claimed as locally observed.

After this green characterization, the existing Linux-only helper and call
were placed behind compiler `#[cfg(target_os = "linux")]` guards instead of a
runtime `cfg!` condition. The same literal command passed after the refactor.
This represents the existing platform contract and retains the helper in Linux
compilation and coverage; it adds no coverage exclusions or threshold changes.
The malformed-revision and unsafe-Git-path validation guards remain in place:
genuine Git provides canonical object IDs and relative paths, and no fake output
or race was introduced merely to exercise their defensive refusal outcomes.

## Checkpoint checks

- `cargo test -p sevro --test run_provenance --locked`: all 18 tests passed
  after the validation follow-up. An earlier attempt encountered the concurrent
  adapter cancellation API transition; that compilation failure was unrelated
  to provenance and is not a behavioral red.
- `cargo clippy -p sevro --test run_provenance --locked -- -D warnings`: passed.
- `rustfmt --edition 2024 --check crates/sevro/src/run/provenance.rs crates/sevro/src/run/provenance/git.rs crates/sevro/tests/run_provenance.rs`:
  passed.
- `bun run check:docs`: passed.
- `bunx prettier --check docs/identity-v1.md docs/specs/rust-protocol-results-parity.md docs/specs/rust-tdd-provenance.md`:
  passed.

Combined candidate coverage, the remaining runner capabilities, native package
distribution and exact-published-commit CI remain separate coordinator gates.
