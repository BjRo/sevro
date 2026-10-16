# Rust initializer TDD evidence

The Rust `sevro init` command preserves the response, coding and repository-skill
starter projects. Its public seams are command exit/stdout/stderr, generated
project files, and execution of those projects through the existing runner.
The independent oracles are [CLI workflow tests](../../tests/cli/workflow.test.ts),
[initializer behavior](../../src/cli/init.ts),
[initializer settings](../../src/cli/init-settings.ts), and complete artifact
trees emitted by the unmodified TypeScript CLI. The behavioral inventory is
[CLI and engine parity](rust-cli-engine-parity.md).

The [Rust subprocess suite](../../crates/sevro/tests/init.rs) executes the actual
compiled binary. Templates retain the existing TypeScript adapters and extension
bytes; the Rust implementation embeds them as assets rather than substituting
different evaluators. The repository-skill template records an absolute Bun path
resolved from the selected local runtime and the generated extension path.

## Scope and limits

This milestone implements initialization. Generated projects are exercised with
the existing TypeScript runner until the Rust engine provides their full runtime
behavior. Those executions establish template compatibility, not completed Rust
engine parity. Repository-skill preparation is dry with synthetic authentication;
it establishes real extension negotiation and retained skill bytes, not native
model execution or skill dispatch. The coding control uses actual platform shell
isolation. Windows acceptance remains unverified.

The tests compare all generated files and printed instructions against the
TypeScript initializer for every template, normalizing only the two temporary
destination paths. They additionally assert expected manifests, independent
positive/negative outcomes and mounted skill bytes. They do not inspect Rust
source text to infer behavior.

## Execution environment

Observed on macOS with Bun 1.3.13. Rust commands below were executed through
`lean-ctx -c` with `RUSTUP_HOME` set to
`/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain/rustup`,
`CARGO_HOME` set to the sibling `cargo` directory, and its `bin` prepended to
`PATH`. The first attempt on the default PATH failed with `cargo: command not
found`; this is environment evidence, not a TDD red. No product code was written
before the corrected command produced the first meaningful red.

## Sequential red and green observations

Each test was added and run before implementing its missing behavior. The same
literal Cargo command was rerun after that slice's implementation. No later
behavior's test was added until the current slice passed.

1. Response template through initialization and real positive/negative runs:
   - Red — `cargo test -p sevro --test init response_template_creates_runnable_positive_and_negative_controls -- --exact`:
     subprocess returned 64 instead of 0; initializer was absent.
   - Green — `cargo test -p sevro --test init response_template_creates_runnable_positive_and_negative_controls -- --exact`:
     one test passed after embedding the unchanged response adapter/case,
     writing manifest/docs, and wiring the CLI dispatcher. Generated positive
     run passed and negative run failed with exit 1.
2. Equals syntax, lexical path resolution, and usable shell instructions:
   - Red — `cargo test -p sevro --test init equals_options_resolve_dot_segments_and_print_a_shell_safe_destination -- --exact`:
     equals-form options returned 64 instead of 0.
   - Green — `cargo test -p sevro --test init equals_options_resolve_dot_segments_and_print_a_shell_safe_destination -- --exact`:
     one test passed; dot segments were removed without creating the unused
     directory and the apostrophe-containing destination was shell quoted.
3. Invalid arguments must have no filesystem effects:
   - Red — `cargo test -p sevro --test init invalid_init_options_fail_without_creating_files -- --exact`:
     `--directory --template=response` was accepted and returned 0 instead of 64.
   - Green — `cargo test -p sevro --test init invalid_init_options_fail_without_creating_files -- --exact`:
     one test passed after refusing ambiguous option values; all invalid cases
     emitted stderr, empty stdout, exit 64 and no created files.
4. Coding template with actual shell checks:
   - Red — `cargo test -p sevro --test init coding_template_grades_real_edits_and_preserves_its_negative_control -- --exact`:
     coding selection returned 64 instead of 0.
   - Green — `cargo test -p sevro --test init coding_template_grades_real_edits_and_preserves_its_negative_control -- --exact`:
     one test passed; real edited-code addition check passed normally and failed
     with the negative-control environment, with shell isolation selected.
5. Repository-skill template with native prerequisites and actual preparation:
   - Red — `cargo test -p sevro --test init repository_skill_template_prepares_the_real_mount_with_explicit_native_prerequisites -- --exact`:
     repository-skill selection returned 64 instead of 0.
   - Green — `cargo test -p sevro --test init repository_skill_template_prepares_the_real_mount_with_explicit_native_prerequisites -- --exact`:
     one test passed; missing authentication refused, explicit dry settings
     produced unassessed preparation with exact mounted skill bytes retained.
6. Existing parser's final-selection/default semantics:
   - Red — `cargo test -p sevro --test init final_template_selection_wins_and_bare_terminator_preserves_defaults -- --exact`:
     an earlier unknown template followed by explicit response still returned
     64 instead of honoring the final selection.
   - Green — `cargo test -p sevro --test init final_template_selection_wins_and_bare_terminator_preserves_defaults -- --exact`:
     one test passed; last selection wins and a bare terminator retains the
     default response template and `sevro-evaluation` destination.

Five additional compatibility checks passed on their first execution and caused
no product changes; no red is claimed for them:

- `cargo test -p sevro --test init existing_destination_and_alias_are_refused_without_touching_user_content -- --exact`:
  existing directory/file and symlink/dangling-link destinations were refused
  without changing target contents or replacing links. This follows the
  exclusive directory reservation introduced by the first slice.
- `cargo test -p sevro --test init initializer_artifacts_and_instructions_match_the_existing_cli -- --exact`:
  byte-for-byte generated artifacts and instructions matched the reference CLI
  across all three templates, default selection, terminator and repeated flags.
- `cargo test -p sevro --test init missing_bun_removes_the_partial_repository_skill_destination -- --exact`:
  removing Bun from the child's PATH returned 64 with an actionable diagnostic,
  removed the partially generated project, preserved neighboring files, and
  allowed initialization at the same destination after restoring the runtime.
- `cargo test -p sevro --test init failed_bun_discovery_removes_the_partial_repository_skill_destination -- --exact`:
  an external runtime executable that printed an absolute path but exited 7
  returned 64 and removed the partial project. The Unix shell fixture replaces
  only runtime discovery; the actual initializer performs all filesystem work.
- `cargo test -p sevro --test init an_uncreatable_parent_preserves_the_obstructing_file -- --exact`:
  a parent path occupied by a file returned 64 with empty stdout and a diagnostic,
  preserved that file's bytes, and created no additional files.

The last three characterizations followed inspection of compiler coverage, which
showed unexecuted runtime discovery, rollback and parent-creation error paths.
They exercise accepted failure behavior through subprocesses and real files;
they required no product changes, test-only production branches or exclusions.
The main coordinator owns the subsequent combined coverage measurement.

## Compiler branch follow-up

Three further public CLI characterizations passed before any product change;
no red is claimed for them:

- `cargo test -p sevro --test init positional_argument_after_terminator_is_refused_without_creating_files -- --exact`:
  `init -- extra` returns 64, empty stdout, the existing initializer help
  diagnostic, and no created files. The TypeScript CLI established these exact
  observable results independently.
- `cargo test -p sevro --test init single_hyphen_is_a_literal_directory_name -- --exact`:
  `init --directory -` creates a response evaluation in a directory literally
  named `-`, with the expected manifest and shell-quoted instructions. The
  TypeScript CLI independently accepts the same argument and destination.
- `cargo test -p sevro --test init relative_bun_discovery_removes_the_partial_repository_skill_destination -- --exact`:
  a real executable that exits successfully but prints a relative Bun path
  causes exit 64, empty stdout, a runtime diagnostic and removal of the partial
  project, preserving the executable. This exercises the Rust initializer's
  external discovery boundary and absolute command-path requirement. The
  TypeScript initializer uses its own absolute `process.execPath`, so no
  corresponding TypeScript discovery failure is claimed.

The first focused command initially encountered unrelated compile errors in
concurrent run implementation; this was not a behavioral red. All three commands
then passed against an isolated archive of published commit `9db8dae` with only
the command follow-up files overlaid. After run compilation was restored,
`cargo test -p sevro --test init --test report --locked` was also run in the
shared worktree. These tests needed no initializer product changes or coverage
exclusions.

## Final checks

- `cargo test -p sevro --test init --test report --locked`: 14 init and 17 report
  tests passed, both in the isolated command candidate and the shared worktree.
- `cargo clippy -p sevro --test init --test report --locked -- -D warnings`:
  passed in the isolated command candidate.
- `rustfmt --edition 2024 --check crates/sevro/tests/init.rs crates/sevro/tests/report.rs crates/sevro/src/report/render.rs`:
  passed for all command follow-up Rust files.
- `bun run check:docs`: passed.
- `bunx prettier --check docs/specs/rust-cli-engine-parity.md crates/sevro/templates`:
  passed; embedded emitted bytes remain identical to the TypeScript initializer.

These are local slice checks. Required exact-commit CI and the complete Rust
port acceptance remain the main coordinator's delivery responsibility.
