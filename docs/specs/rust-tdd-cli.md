# Rust CLI TDD evidence

This record covers the first Rust CLI slices on 2026-10-16. The acceptance seam
is the compiled `sevro` subprocess, with a fresh empty working directory for
every invocation. Every test asserts that the invocation creates no files.
The independent oracles are the original
[`help.test.ts`](../../tests/cli/help.test.ts),
[`help.ts`](../../src/cli/help.ts),
[`presentation.ts`](../../src/cli/presentation.ts), the
[result contract](../results-v1.md), and the
[CLI parity specification](rust-cli-engine-parity.md).

The initial Cargo scaffold compiled before behavior tests and returned exit 64
for unimplemented commands. It contained no Bun fallback. The npm entrypoint and
TypeScript runner remain available during the incomplete migration.

## Execution environment

Commands below ran from the port worktree with Rust 1.99.0. They were passed
literally to `lean-ctx -c` with these environment values:

```sh
export RUSTUP_HOME=/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain/rustup
export CARGO_HOME=/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain/cargo
export PATH="$CARGO_HOME/bin:$PATH"
```

The baseline `bun test tests/cli/help.test.ts` passed all 18 cases and 160
assertions before Rust implementation. Each focused Rust command below compiled
and reached the missing-behavior assertion on its first red run.

## Observed slices

1. Top-level help: no arguments, `--help`, `-h`, and `help` return 0, emit only
   help on stdout, and place examples before commands.

   Red — `cargo test --offline --locked -p sevro --test cli top_level_help_has_examples_before_commands_without_preparing_a_run -- --exact`:
   exit 101; expected invocation exit 0, received 64 for `[]`.

   Green — `cargo test --offline --locked -p sevro --test cli top_level_help_has_examples_before_commands_without_preparing_a_run -- --exact`:
   one test passed, including all four aliases.

2. Run help: preserve required routes, paths, trial settings, defaults, and
   the three existing help aliases.

   Red — `cargo test --offline --locked -p sevro --test cli run_help_explains_required_options_defaults_and_paths_without_preparing_a_run -- --exact`:
   exit 101; expected invocation exit 0, received 64 for `run --help`.

   Green — `cargo test --offline --locked -p sevro --test cli run_help_explains_required_options_defaults_and_paths_without_preparing_a_run -- --exact`:
   one test passed, including all three aliases.

3. Version: both aliases report the installed package version followed by one
   newline, with empty stderr. The test obtains its expected version from the
   existing npm package metadata; the binary obtains it from Cargo metadata.

   Red — `cargo test --offline --locked -p sevro --test cli version_reports_the_installed_package_version_without_preparing_a_run -- --exact`:
   exit 101; expected invocation exit 0, received 64 for `--version`.

   Green — `cargo test --offline --locked -p sevro --test cli version_reports_the_installed_package_version_without_preparing_a_run -- --exact`:
   one test passed, including both aliases.

4. Report help: preserve required result input, path rules, JSON format, and
   Markdown default without reading result files.

   Red — `cargo test --offline --locked -p sevro --test cli report_help_explains_inputs_and_output_without_reading_results -- --exact`:
   exit 101; expected invocation exit 0, received 64 for `report --help`.

   Green — `cargo test --offline --locked -p sevro --test cli report_help_explains_inputs_and_output_without_reading_results -- --exact`:
   one test passed, including all three aliases.

5. Init help: preserve template choices, existing-path refusal, credential
   prerequisites, and the next report command without creating a project.

   Red — `cargo test --offline --locked -p sevro --test cli init_help_explains_safe_templates_without_creating_files -- --exact`:
   exit 101; expected invocation exit 0, received 64 for `init --help`.

   Green — `cargo test --offline --locked -p sevro --test cli init_help_explains_safe_templates_without_creating_files -- --exact`:
   one test passed, including all three aliases.

6. Demo help: preserve the credential-free example description and evidence
   location without preparing a run.

   Red — `cargo test --offline --locked -p sevro --test cli demo_help_explains_owned_inputs_without_preparing_a_run -- --exact`:
   exit 101; expected invocation exit 0, received 64 for `demo --help`.

   Green — `cargo test --offline --locked -p sevro --test cli demo_help_explains_owned_inputs_without_preparing_a_run -- --exact`:
   one test passed, including all three aliases.

7. Invalid top-level command: `nonsense` returns 64, emits unassessed execution,
   grading, and task states with no cases or evidence, and supplies the existing
   corrective stderr message. Last explicit `--json`/`--no-json` determines
   whether stdout is one versioned result or the human state line.

   Red — `cargo test --offline --locked -p sevro --test cli invalid_command_reports_unassessed_result_and_honors_last_output_selection -- --exact`:
   exit 101; expected corrective stderr, received an empty string.

   Green — `cargo test --offline --locked -p sevro --test cli invalid_command_reports_unassessed_result_and_honors_last_output_selection -- --exact`:
   one test passed, including human, JSON, and both output-override orders.

The first top-level help implementation attempt encountered a missing included
asset after a file-write tool refused a redirect. Creating the asset corrected
that compiler error; it is not counted as behavioral red evidence.

After six help/version slices were green, their repeated dispatch branches were
refactored into one informational-command module. The focused suite then passed
all six tests before the invalid-command slice started. Matching retains the
existing joined-argument behavior from `informationCommand`; a single literal
`help run` argument produces run help in both implementations.

## Final checks for this slice

- `cargo test --offline --locked -p sevro --test cli`: 7 passed, 0 failed.
- `cargo clippy --offline --locked --workspace --all-targets -- -D warnings`:
  passed against the workspace state at this checkpoint.
- The owned Rust files were formatted with Rustfmt 2024 edition.
- `bun run check:docs`: passed after adding this evidence record.
- A separate subprocess comparison checked exact exit/stdout/stderr equality
  against the TypeScript CLI for all 18 original informational forms plus the
  single-argument `help run` form: all 19 matched.

This is evidence for informational commands and the named invalid top-level
command behavior. It does not establish run parsing, evaluation, demo execution,
installation, platform acceptance, or the independently implemented init/report
commands. The [overall port specification](rust-port.md) retains those obligations.
