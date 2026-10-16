# Rust run options and saved settings TDD evidence

This slice preserves the public `sevro run` option and saved-manifest contracts.
Its oracle is [saved run settings v1](../run-settings-v1.md), the independent
assertions in [run-manifest tests](../../tests/cli/run-manifest.test.ts) and
[invocation validation](../../tests/cli/invocation-validation.test.ts), and the
[CLI parity inventory](rust-cli-engine-parity.md). Tests invoke the compiled Rust
binary and inspect result JSON, retained evidence, diagnostics and filesystem
effects. They do not call parser internals or inspect source text.

## Independent baseline and scope

Before repository edits, a minimal inline `sevro.output` case and native Codex
dry route were exercised through the unmodified TypeScript CLI. Six observations
passed: saved selections, repeated identity, CLI precedence with cwd-relative
paths, equivalent explicit identity, canonical manifest-directory aliases, and
an invalid numeric setting type. That temporary baseline lived outside the
repository at `/private/tmp/sevro-run-options-baseline.eThnGO`.

Subsequent independent TypeScript observations in that directory confirmed
canonical output through a dangling directory symlink and the exact normalized
minimal runtime policy. An explicit runtime file replaces a malformed default;
equivalent explicit and discovered files have the same policy identity.

The later `/tmp/sevro-options-quality-baseline.mjs` probe checked real file
permissions, omitted required selections, cyclic paths and empty extension
sources through the TypeScript CLI. It also confirmed that integral decimal
and exponent spellings retain the same normalized settings and identity as
ordinary JSON numbers. Its final observations are retained outside the checkout
in the temporary directory `sevro-options-quality-baseline-7JqSGP`.

The later `/tmp/sevro-options-boundary-baseline.mjs` probe confirmed inline
flag-looking path values, empty-path diagnostics, negative-option syntax,
the inclusive 64 KiB file bound, empty saved source arrays and cyclic selected
input paths. Its final observations are retained outside the checkout in
`sevro-options-boundary-baseline-53nZAB`.

The first Rust slice uses one dry trial and explicit runner/project digests.
Additional dry trial counts demonstrate preparation and retained settings;
they make no claim about candidate scheduling or concurrency. Native execution,
runtime policy enforcement and full route support remain separate slices.

## Sequential observations

1. Saved manifest selections through native dry preparation:
   - Red — `cargo test -p sevro --test run_options saved_manifest_supplies_native_dry_settings_and_retains_its_selection -- --exact`:
     the CLI returned 64 for unsupported `--run-manifest-file`, rather than 0.
   - Green — `cargo test -p sevro --test run_options saved_manifest_supplies_native_dry_settings_and_retains_its_selection -- --exact`:
     one test passed after loading saved settings, resolving saved paths from
     the manifest directory and retaining canonical manifest provenance. The
     real result remained unassessed; the preview omitted credential paths and
     retained evidence omitted credential content.
2. Explicit case-file selection replaces saved extension input:
   - Red — `cargo test -p sevro --test run_options cli_case_file_replaces_the_saved_extension_selection --locked -- --exact`:
     the run returned 64 because both saved extension and explicit case-file
     alternatives remained selected.
   - Green — `cargo test -p sevro --test run_options cli_case_file_replaces_the_saved_extension_selection --locked -- --exact`:
     one test passed after removing the saved extension command, source list and
     case ID before applying the explicit case file.
3. Malformed CLI input retains established diagnostics:
   - Red — `cargo test -p sevro --test run_options malformed_cli_arguments_keep_configuration_failure_diagnostics --locked -- --exact`:
     an unknown flag used the temporary Rust-slice diagnostic instead of
     `invalid CLI arguments`.
   - Green — `cargo test -p sevro --test run_options malformed_cli_arguments_keep_configuration_failure_diagnostics --locked -- --exact`:
     one test passed for unknown flags, missing/ambiguous values, invalid boolean
     syntax and an extra positional command, without allocating a run.
4. Bare option terminator:
   - Red — `cargo test -p sevro --test run_options bare_option_terminator_preserves_the_selected_run --locked -- --exact`:
     a final `--` was rejected as an unknown option with exit 64.
   - Green — `cargo test -p sevro --test run_options bare_option_terminator_preserves_the_selected_run --locked -- --exact`:
     one test passed; a final terminator preserves the run, while a positional
     command after it remains a configuration error.
5. Explicit adapter route replaces saved native selections:
   - Red — `cargo test -p sevro --test run_options cli_adapter_replaces_saved_native_settings_and_negative_dry_executes --locked -- --exact`:
     the saved native host remained and caused an exclusive-route error.
   - Green — `cargo test -p sevro --test run_options cli_adapter_replaces_saved_native_settings_and_negative_dry_executes --locked -- --exact`:
     one test passed after removing saved native-only settings. `--no-dry`
     executes the existing TypeScript adapter; its real metadata is retained.
     The prompt-only case completes without a fabricated task assessment.
6. Explicit native route replaces a saved adapter:
   - Red — `cargo test -p sevro --test run_options cli_native_host_replaces_a_saved_adapter_without_hiding_explicit_conflicts --locked -- --exact`:
     the saved adapter remained and caused an exclusive-route error.
   - Green — `cargo test -p sevro --test run_options cli_native_host_replaces_a_saved_adapter_without_hiding_explicit_conflicts --locked -- --exact`:
     one test passed after clearing the saved adapter. Supplying both routes
     explicitly still fails; no unselected adapter module is opened.
7. Empty optional saved source list:
   - Red — `cargo test -p sevro --test run_options saved_empty_extension_source_list_selects_no_entries_for_a_case_file --locked -- --exact`:
     an empty optional list incorrectly required an extension command.
   - Green — `cargo test -p sevro --test run_options saved_empty_extension_source_list_selects_no_entries_for_a_case_file --locked -- --exact`:
     one test passed after distinguishing an empty list from selected extension
     sources. The case-file route retains zero extension sources.
8. Missing output directory selected through a symlink:
   - Red — `cargo test -p sevro --test run_options a_missing_results_directory_is_resolved_through_its_symlink --locked -- --exact`:
     the run returned 70 because directory creation treated the existing alias
     as the destination rather than resolving its missing target.
   - Green — `cargo test -p sevro --test run_options a_missing_results_directory_is_resolved_through_its_symlink --locked -- --exact`:
     one test passed after resolving the symlink before creating the target.
     The alias survives, while result paths and latest evidence use the target.
9. Explicit runtime configuration and policy identity:
   - Red — `cargo test -p sevro --test run_options explicit_runtime_configuration_replaces_default_and_binds_real_policy_identity --locked -- --exact`:
     the CLI returned 64 for unknown `--runtime-config-file`, rather than 0.
   - Green — `cargo test -p sevro --test run_options explicit_runtime_configuration_replaces_default_and_binds_real_policy_identity --locked -- --exact`:
     one test passed after loading the selected file and integrating its actual
     normalized policy into retained configuration and evaluation identity.
     The explicit file replaces the malformed default. This bounded slice
     accepts the minimal format declaration and refuses unsupported declarations.
10. Empty extension-source input:
    - Red — `cargo test -p sevro --test run_options empty_extension_source_names_the_missing_input_before_loading_the_command --locked -- --exact`:
      the CLI reported a generic invalid-arguments diagnostic instead of naming
      the missing extension source, unlike the existing invocation contract.
    - Green — `cargo test -p sevro --test run_options empty_extension_source_names_the_missing_input_before_loading_the_command --locked -- --exact`:
      one test passed after leaving the empty source to semantic source-list
      validation. Both separate and inline empty values fail before command
      loading or run allocation.
11. Inline path values beginning with option tokens:
    - Red — `cargo test -p sevro --test run_options inline_path_values_preserve_leading_option_tokens --locked -- --exact`:
      `--results-root=--dry` returned 64 as a missing value, although the
      TypeScript CLI accepts the literal path value.
    - Green — `cargo test -p sevro --test run_options inline_path_values_preserve_leading_option_tokens --locked -- --exact`:
      one test passed after distinguishing inline values from ambiguous separate
      argument tokens. The literal cwd-relative output directory is retained;
      it does not change the selected dry mode.
12. Empty selected paths:
    - Red — `cargo test -p sevro --test run_options empty_selected_paths_name_the_missing_input --locked -- --exact`:
      an empty case path produced a generic parser error instead of the existing
      missing-input diagnostic.
    - Green — `cargo test -p sevro --test run_options empty_selected_paths_name_the_missing_input --locked -- --exact`:
      one test passed for separate and inline empty values across supported
      input/output path settings. Empty adapter selection preserves the existing
      missing-route diagnostic. A shared path-setting list also preserves saved
      relative-path resolution.

The following characterizations passed on their first execution, with no further
product changes and no claimed red:

- `cargo test -p sevro --test run_options explicit_cli_settings_replace_saved_values_and_relative_output_paths --locked -- --exact`:
  saved trials 2, jobs 1 and threshold 0.5 repeat with stable identity; explicit
  CLI selections replace them with 1, 3 and 1. Explicit output paths resolve
  from cwd, and relocating only output leaves identity unchanged.
- `cargo test -p sevro --test run_options invalid_manifest_fields_return_one_unassessed_result_before_storage --locked -- --exact`:
  invalid roots, versions, unknown fields, scalar/list value types, blank values
  and CLI-only saved options return one unassessed JSON result naming the file
  and field, with null evidence and no run storage.
- `cargo test -p sevro --test run_options unreadable_or_unsafe_manifests_preserve_actionable_json_failure --locked -- --exact`:
  missing, malformed, oversized, symlink and directory manifests return 64 with
  actionable file context and no leaked malformed JSON body.
- `cargo test -p sevro --test run_options manifest_directory_alias_resolves_paths_from_its_canonical_target --locked -- --exact`:
  a symlinked containing directory uses its canonical target for manifest and
  saved relative case/project paths.
- `cargo test -p sevro --test run_options failed_manifest_loading_honors_the_last_explicit_json_selection --locked -- --exact`:
  the last `--json` or `--no-json` controls failure presentation even when the
  selected manifest is missing.
- `cargo test -p sevro --test run_options invalid_aggregation_settings_are_refused_before_storage --locked -- --exact`:
  invalid conditions, zero/negative/fractional/unsafe trial counts, invalid jobs
  and out-of-range/nonfinite thresholds fail before run allocation.
- `cargo test -p sevro --test run_options discovered_and_explicit_runtime_files_share_policy_identity --locked -- --exact`:
  discovery reads only the selected project root; selecting that same file
  explicitly preserves configuration and evaluation identity.
- `cargo test -p sevro --test run_options invalid_runtime_files_fail_before_admission_without_leaking_the_body --locked -- --exact`:
  missing explicit files, invalid JSON, oversized files, directories, invalid
  versions, nonobjects, unknown declarations and a symlinked default fail with
  exit 64 before storage, without retaining the malformed body.
- `cargo test -p sevro --test run_options selected_codex_binary_uses_path_and_honors_an_explicit_override --locked -- --exact`:
  PATH selection skips missing entries and a directory named `codex`, canonicalizes an executable alias,
  honors an explicit executable independently of PATH, and refuses a missing
  executable after its execution permission is removed. Dry selection never
  invokes the selected program.
- `cargo test -p sevro --test run_options incompatible_input_selections_are_refused_before_run_allocation --locked -- --exact`:
  incomplete source-map pairs, nondirectory roots, invalid digests, native-only
  inputs on adapter routes and extension-only inputs on a case-file route fail
  before storage. The first attempt encountered an unrelated shared compilation
  transition in fixture integration; after its owner restored compilation, the
  first behavioral execution passed. No product red is claimed for that attempt.
- `cargo test -p sevro --test run_options saved_native_timeout_is_overridden_and_validated_before_admission --locked -- --exact`:
  a saved numeric timeout enters resolved settings and configuration identity;
  explicit boundary values replace it without changing route identity. Changing
  to an adapter clears the saved timeout, while an explicit adapter/timeout
  conflict, invalid interval and saved string type fail before execution.
- `cargo test -p sevro --test run_options unreadable_selected_configuration_is_refused_before_storage --locked -- --exact`:
  regular manifest and runtime files with read permission removed produce
  exit 64, name the selected file and leave no result storage. The test restores
  permissions before assertions and cleanup.
- `cargo test -p sevro --test run_options incomplete_input_selections_fail_before_run_allocation --locked -- --exact`:
  absent native route, credential, model or effort; absent or conflicting case
  alternatives; incomplete extension selection; and private extension inputs on
  a case-file route fail with the established diagnostic before loading inputs.
- `cargo test -p sevro --test run_options filesystem_resolution_failures_do_not_allocate_runs --locked -- --exact`:
  a cyclic result alias, a regular file used as a directory ancestor and an
  inaccessible project fail with exit 64 and path context before storage.
- `cargo test -p sevro --test run_options integral_decimal_and_exponent_settings_preserve_numeric_identity --locked -- --exact`:
  raw JSON integer, integral-decimal and exponent spellings normalize trials,
  jobs, threshold and native timeout identically. Equivalent explicit CLI values
  preserve the same evaluation identity. No numeric product change was needed.
- `cargo test -p sevro --test run_options configuration_files_accept_64_kib_and_refuse_the_next_byte --locked -- --exact`:
  manifest and minimal runtime files of exactly 65,536 bytes retain the same
  identity as their compact forms. Adding one byte fails with exit 64 and no
  new result storage.
- `cargo test -p sevro --test run_options cyclic_selected_input_paths_fail_before_loading_or_storage --locked -- --exact`:
  cyclic case, adapter, native, project/configuration, runtime, source-map and
  extension input selections fail with exit 64 and path context before loading
  the candidate or allocating storage.

The original saved-selection test was extended to assert that supplied SHA-256
values containing both digits and letters are retained exactly in identity.
`cargo test -p sevro --test run_options saved_manifest_supplies_native_dry_settings_and_retains_its_selection --locked -- --exact`
passed immediately after that assertion was added. The directory-on-PATH addition
to the existing executable-selection test also passed its literal command above
on its first execution; neither extension is a claimed behavior red.

The source-input test now also selects an empty saved source array, and the
malformed-argument test includes `--no-model`, `--no-dry=false` and a separate
`--` used as a missing path value. Both extended tests passed their literal
commands above on the first execution after those assertions were added.

After these greens, three duplicate checks were removed without changing the
contract. The digest helper now receives the value already selected by its
caller, rather than performing a second required lookup. Manifest loading
returns the canonical path already used to resolve saved paths, rather than
resolving the file again during merge. Source selection still rejects an empty
array, but no longer rechecks every element for emptiness: CLI path validation
and saved-array validation both establish that invariant before merging.
The full `cargo test -p sevro --test run_options --locked` command passed after
these simplifications.

## Checkpoint 6 option and configuration follow-up

The external `/tmp/sevro-checkpoint6-options-readonly.mjs` probe compared the
unchanged TypeScript CLI with the frozen checkpoint 6 Rust binary. Its final
paired observations are retained in
`/private/tmp/sevro-checkpoint6-options-2kPX9V/observations.json`. They establish
the exact diagnostics below, explicit runtime-alias identity, and the runtime
limit after UTF-8 decoding. All inputs were ordinary temporary files or CLI
arguments; no filesystem races or substituted process APIs were used.

The empty-value family grew one example at a time. Each addition was executed
before another example or product change was added. The final 22 examples cover
separate and inline empty values for 11 supported options; they were not added
as a batch before the first green.

1. Separate empty `--model`:
   - Red — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     the parser returned `invalid CLI arguments: --model requires a value`
     instead of `missing --model; supply --model with a value`.
   - Green — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     one test passed after distinguishing a supplied empty value from a
     missing or ambiguous argument.
   - First-green characterizations — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     each later addition passed before adding the next: inline model, then
     separate and inline effort, condition, trials, jobs, threshold and
     run-manifest-file. These 13 additions required no product changes.
2. Separate empty `--host`:
   - Red — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     the ordinary missing-host diagnostic differed from the established
     `missing --adapter-module or --host` route diagnostic.
   - Green — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     one test passed after using the existing empty-route diagnostic.
   - First-green characterization — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     the subsequently added inline host form passed without another change.
3. Separate empty `--runner-build-digest`:
   - Red — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     the missing-value diagnostic differed from
     `--runner-build-digest must be a 64-character SHA-256 digest`.
   - Green — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     one test passed after letting supplied empty digests reach the existing
     digest validator.
   - First-green characterizations — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     inline runner digest, separate project digest and inline project digest
     were added and passed individually without another product change.
4. Separate empty `--codex-timeout-ms`:
   - Red — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     the missing-value diagnostic differed from
     `invalid Codex host configuration`.
   - Green — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     one test passed after preserving the existing empty-timeout diagnostic.
   - First-green characterization — `cargo test -p sevro --test run_options empty_scalar_and_manifest_values_preserve_validation_diagnostics --locked -- --exact`:
     the final inline timeout addition passed without another product change.
5. Unsearchable `.codex` directory:
   - Red — `cargo test -p sevro --test run_options unreadable_codex_configuration_paths_fail_before_admission --locked -- --exact`:
     a real directory with search permission removed produced an inspect
     diagnostic instead of `Cannot read Codex configuration: <path>`.
   - Green — `cargo test -p sevro --test run_options unreadable_codex_configuration_paths_fail_before_admission --locked -- --exact`:
     one test passed after matching the baseline display message while
     retaining the filesystem cause in `RunError`.
   - First-green characterization — `cargo test -p sevro --test run_options unreadable_codex_configuration_paths_fail_before_admission --locked -- --exact`:
     the subsequently added ordinary file named `.codex` produced the same
     established refusal without another product change. Fixture permissions
     are restored before assertions.
6. Explicit runtime-file alias:
   - First-green characterization — `cargo test -p sevro --test run_options explicit_runtime_file_aliases_preserve_policy_identity --locked -- --exact`:
     a real explicit symlink and its direct target both prepared a dry trial,
     retained the canonical target and normalized minimal policy, and produced
     equal configuration and evaluation identities. The alias survived. No
     product change or red is claimed; default-file symlink refusal remains
     covered by the earlier runtime cases.
7. Runtime configuration size after UTF-8 decoding:
   - Red — `cargo test -p sevro --test run_options runtime_configuration_bounds_decoded_utf8_before_policy_validation --locked -- --exact`:
     a 22,039-byte file containing 22,000 invalid UTF-8 bytes inside a JSON
     string produced a generic invalid-configuration error. The TypeScript
     CLI replaces those bytes during decoding, producing 66,039 UTF-8 bytes,
     and reports `invalid runtime configuration: runtime configuration exceeds 64 KiB`.
   - Green — `cargo test -p sevro --test run_options runtime_configuration_bounds_decoded_utf8_before_policy_validation --locked -- --exact`:
     one test passed after matching that decoding before the post-read size
     check and JSON parsing. The initial regular-file/raw-size check remains;
     the existing exact 65,536-byte and 65,537-byte cases still pass. This
     rejects the input before policy validation and does not accept additional
     runtime declarations.

Every failure case asserts the complete exit-64 JSON result: execution not run,
grading not requested, task not assessed, null evidence and no cases. The tests
also require no run storage to be allocated.

## Shared option integration

The fixture, extension and adapter owners drive their public behavior tests and
implementations. This options owner supplies their requested fields only after
their public CLI tests expose missing support. Their execution ledgers own the
complete cross-module red/green evidence:

- Repository mapping fields follow the observed red for
  `cargo test -p sevro --test run_repository prepares_clean_repository_dry_run --locked -- --exact`:
  `--case-source-root` was unsupported. The options are canonical path inputs;
  the existing pair rule remains `case sources require a root and map file`.
- Extension selection follows the observed red for
  `cargo test -p sevro --test run_extension resolves_and_prepares_a_real_extension_for_a_native_dry_run -- --exact`:
  `--extension-command-file` was unsupported. The source selection represents
  either one case file or one extension command, ID and repeated source list.
- Adapter selection follows the observed red for
  `cargo test --offline --locked -p sevro --test run_adapter executes_existing_typescript_adapter -- --exact`:
  `--adapter-module` was unsupported. Candidate selection represents either
  native Codex inputs or a real adapter module; adapter metadata comes from the
  bridge rather than fabricated native settings.

All three owners subsequently observed their same-command initial greens.
The provenance owner later observed
`cargo test -p sevro --test run_provenance derives_non_git_project_identity_without_a_digest_override -- --exact`
fail with a missing project-digest diagnostic. The options boundary therefore
made the project override optional and continues validating supplied digests;
provenance derivation and its green evidence belong to that owner's slice.

Subsequent integration fields were supplied after these owners' observed reds:

- `cargo test -p sevro --test run_provenance standalone_runner_identity_binds_the_installed_binary_without_overrides -- --exact`:
  the missing runner-digest diagnostic required making that override optional.
  Supplied digests still receive validation. The provenance owner observed the
  identical command pass after deriving the actual installed binary digest.
- `cargo test -p sevro --test run_native_codex --locked executes_isolated_codex_turn -- --exact`:
  the native dry-only refusal required permitting execution and preserving the
  canonical credential path for the native owner to read at execution.
- `cargo test -p sevro --test run_extension passes_private_configuration_to_extensions_and_retains_only_redacted_identity -- --exact`:
  unknown `--extension-configuration-file` required the paired private/redacted
  path inputs. The extension owner observed the identical command pass with
  private protocol input, redacted-only identity and lone-private refusal.
- `cargo test -p sevro --test run_native_codex --locked times_out_native_turn_and_owned_descendant -- --exact`:
  unknown `--codex-timeout-ms` required the native timeout selection, its saved
  numeric form and route validation. The native owner observed the identical
  command pass: the 200 ms deadline terminates the owned descendant, retains
  the timeout diagnostic and signal evidence, and removes private native state.
- `cargo test -p sevro --test run_extension explicit_extension_selection_replaces_saved_case_and_source_lists -- --exact`:
  the extension owner observed exit 64 because a saved case file remained
  selected alongside the explicit extension. Clearing that saved alternative
  made the identical command pass. The real extension observes one replacement
  source; unselected saved paths are not opened.

## Current boundary and remaining work

This boundary covers saved settings for the currently implemented case, extension,
native and adapter routes. It does not establish complete settings parity.
Semantic/advisory routes, Claude selection, diagnostic controls and full runtime
policies require their own public slices. The minimal runtime declaration is
loaded and represented in identity; environment, tools, grants, seeds and hooks
are still refused until their real execution behavior exists. Run-state-root
overrides remain refused until the ownership lifecycle supports them. Reverse
case-to-extension manifest replacement is now covered by the extension owner's
public test. Default provenance and native execution are integrated by their
respective owners; checkout-root selection remains pending.

## Final checks

- `cargo test -p sevro --test run_options --locked`: 33 passed, 0 failed,
  0 ignored and 0 filtered out. An earlier expanded-suite attempt encountered a shared compilation transition
  because `provenance::ProvenanceFailure` was not yet present. The owner completed
  that integration before the successful repeat; it was not behavior-red evidence.
- `cargo clippy -p sevro --test run_options --locked -- -D warnings`:
  passed at the expanded 33-test boundary. At the earlier boundary it found a
  core clone-to-slice warning, which the runtime owner fixed before observing
  `cargo clippy --workspace --all-targets --locked -- -D warnings` pass.
- `rustfmt --check --edition 2024 --config skip_children=true crates/sevro/src/run/options.rs crates/sevro/src/run/runtime_config.rs crates/sevro/src/run/identity.rs crates/sevro/tests/run_options.rs`:
  passed.
- `bunx prettier --check docs/specs/rust-tdd-run-options.md`: passed.
- `bun run check:docs`: passed.

The main coordinator owns combined compiler coverage, full acceptance and
exact-commit CI. These focused observations do not declare the complete Rust
port finished. Race-dependent filesystem error paths remain unverified by these
deterministic public tests; they were not replaced with artificial faults or
coverage exemptions. The post-read runtime size guard is now covered by the
independently observed UTF-8 decoding case above.

The remaining guards include a file changing after metadata or content reads,
a missing path changing before `lstat`, and a process losing its current
directory during resolution. The threshold conversion failure is unreachable
after its finite positive range check; a canonical manifest without a parent
cannot pass the regular-file check. These are stated limits of the deterministic
public evidence, rather than claimed passing cases.
