# Rust deterministic grader TDD evidence

The public seam is `sevro run --json --case-file ... --adapter-module ...`.
Tests invoke the compiled Rust CLI and a real Bun adapter that completes a
candidate turn. They inspect the command result, retained run and trial
evidence, and exact raw final-message bytes. The expected behavior comes from
the unchanged TypeScript CLI and the
[built-in grader contract](../builtin-graders-v1.md), with assessment and exit
semantics defined by the [results contract](../results-v1.md).

Commands run from the worktree root with the pinned Rust toolchain selected.
The literal Cargo commands below run through lean-ctx with explicit
`CARGO_HOME`, `RUSTUP_HOME` and the toolchain's `cargo/bin` on PATH.

## Exact output from a completed turn

The TypeScript CLI baseline returned exit 0 with completed execution and grading,
a passed task and one `sevro.output` check. Its detail is `ok`, its evidence
reference identifies the final-message observation, and the retained bytes are
exactly `ready`. Run evidence identifies the built-in grader as version `1.0.0`.

- Red — `cargo test --locked -p sevro --test run_graders exact_output_passes_complete_adapter_turn -- --exact`:
  the Rust CLI returned exit 64 with `Rust grading and required-evidence
assessment are not yet implemented`, instead of the expected exit 0.
- Green — `cargo test --locked -p sevro --test run_graders exact_output_passes_complete_adapter_turn -- --exact`:
  one test passed after actual assessment, result aggregation and retained
  evidence were integrated. The test compares CLI results with the run,
  trial, latest and result files, and verifies the literal final-message hash.

## Mismatch and observation availability

The following regressions were added and run sequentially after the first
green. Each passed on its first executable run: the cohesive exact-output
implementation already handled these inputs. They are acceptance
characterizations, not additional claimed red/green slices.

- `cargo test --locked -p sevro --test run_graders exact_output_mismatch_fails_with_retained_observation -- --exact`
  verifies that `wait` produces exit 1, completed grading, a failed task and
  `exact output did not match`, with the actual observation retained.
- `cargo test --locked -p sevro --test run_graders exact_output_does_not_trim_the_observed_message -- --exact`
  verifies that `ready\n` also fails with exit 1. The retained bytes and literal
  SHA-256 digest include the trailing newline.
- `cargo test --locked -p sevro --test run_graders missing_output_is_unavailable_without_a_fabricated_evidence_reference -- --exact`
  verifies that a null message produces exit 4, unavailable grading and an
  unassessed task. The check has no evidence reference, and raw-result path and
  digest remain null.
- `cargo test --locked -p sevro --test run_graders incomplete_matching_output_is_unavailable_and_retains_partial_bytes -- --exact`
  verifies that even matching `ready` bytes cannot pass when incomplete. The
  result is exit 4, unavailable grading and an unassessed task, while the partial
  observation, digest, bytes and check evidence reference remain available.

These outcomes were independently observed through the unchanged TypeScript
CLI before implementation. Every characterization checks matching CLI, run and
trial evidence; failed and unavailable workspaces remain available until the
test explicitly removes them. A concurrent native-host/runtime compile repair
and a corrected shell invocation preceded two executable runs; neither is
behavioral red evidence.

## Trial threshold aggregation

`cargo test --locked -p sevro --test run_graders completed_trial_outcomes_are_aggregated_at_the_requested_threshold -- --exact`
passed on its first run after the observation characterizations. The unchanged
TypeScript CLI first established the oracle: a real adapter returns `ready`,
`no`, `ready` in three successive calls with `--jobs 1`. Threshold `0.5` gives
exit 0 and a passed case; threshold `0.75` gives exit 1 and a failed case.
Individual trial verdicts remain passed, failed and passed in both runs.

The regression checks each trial's actual bytes and retained evidence, plus
cleanup of successful workspaces and retention of the failed one. This
characterizes the sequential lifecycle and aggregation already integrated by
the runtime owner; it does not establish concurrent scheduling parity.

## JSON validity from complete output

The unchanged TypeScript CLI established independent public baselines for
`sevro.output` with `validJson: true`. A complete raw JSON document passes with
exit 0; invalid JSON produces a failed check and exit 1. Both retain a single
check outcome and the exact final-message bytes. The configuration is validated
as a boolean before execution, without changing other declaration diagnostics.

- Red — `cargo test --locked -p sevro --test run_graders valid_json_output_passes_a_complete_document -- --exact`:
  Rust rejected the supported `validJson` configuration with exit 64.
- Green — `cargo test --locked -p sevro --test run_graders valid_json_output_passes_a_complete_document -- --exact`:
  one test passed after boolean validation and raw JSON syntax assessment were
  added. The test checks the literal SHA-256 of the whitespace-preserving bytes.

`cargo test --locked -p sevro --test run_graders valid_json_output_fails_invalid_json_with_an_assessed_task -- --exact`
passed on its first run. This characterization verifies completed grading,
a failed task, exit 1 and the detail `output is not valid JSON` for `ready`.

- Red — `cargo test --locked -p sevro --test run_graders valid_json_output_accepts_one_complete_json_fence -- --exact`:
  Rust rejected the supported complete JSON fence with exit 1 instead of 0.
- Green — `cargo test --locked -p sevro --test run_graders valid_json_output_accepts_one_complete_json_fence -- --exact`:
  one test passed after recognizing a complete JSON fence; the raw artifact
  retains the fence bytes and their independent literal digest.

- Red — `cargo test --locked -p sevro --test run_graders valid_json_output_distinguishes_prose_around_a_valid_fence -- --exact`:
  Rust reported `output is not valid JSON` for prose surrounding one valid
  fence, instead of the baseline's `output is not exactly one JSON document`.
- Green — `cargo test --locked -p sevro --test run_graders valid_json_output_distinguishes_prose_around_a_valid_fence -- --exact`:
  one test passed after separating valid fenced content from exact-document
  matching. The original message remains in the raw evidence artifact.

The following cases were added and run one at a time after that green. Each
passed on its first run and is acceptance characterization, not another claimed
red/green repair. The independent TypeScript CLI baselines establish every
expected state, detail and retained byte sequence.

- `cargo test --locked -p sevro --test run_graders valid_json_output_rejects_multiple_json_fences -- --exact`
  rejects two JSON fences as invalid JSON with completed grading and exit 1.
- `cargo test --locked -p sevro --test run_graders valid_json_output_rejects_multiple_raw_documents -- --exact`
  rejects `{} []` with the same assessment and detail.
- `cargo test --locked -p sevro --test run_graders valid_json_output_accepts_supported_fence_case_spacing_and_line_endings -- --exact`
  accepts uppercase `JSON`, header spaces/tabs, CRLF and the existing JavaScript
  trimming of BOM/nonbreaking spaces; original bytes and their literal hash survive.
- `cargo test --locked -p sevro --test run_graders valid_json_output_keeps_missing_observations_unavailable -- --exact`
  retains exit 4, unavailable grading and an unassessed task without raw bytes
  or a fabricated final-message reference.
- `cargo test --locked -p sevro --test run_graders valid_json_output_keeps_incomplete_valid_json_unavailable -- --exact`
  keeps valid but partial JSON unassessed with exit 4 and retains its bytes.
- `cargo test --locked -p sevro --test run_graders valid_json_false_disables_the_json_assertion -- --exact`
  accepts complete non-JSON text when the JSON assertion is explicitly disabled.
- `cargo test --locked -p sevro --test run_graders valid_json_failure_precedes_a_simultaneous_exact_text_failure -- --exact`
  preserves the JSON failure detail when both JSON validity and exact text fail.
- `cargo test --locked -p sevro --test run_graders exact_text_still_applies_after_json_validity_passes -- --exact`
  retains the exact-text failure after valid JSON passes its earlier stage.
- `cargo test --locked -p sevro --test run_graders valid_json_output_accepts_a_number_beyond_finite_float_range -- --exact`
  accepts the JSON number `1e400`, preserving its literal bytes and digest.
- `cargo test --locked -p sevro --test run_graders valid_json_output_accepts_an_escaped_unpaired_surrogate -- --exact`
  accepts the JSON string containing escaped `\ud800`, without converting or
  replacing the candidate's original JSON text.
- `cargo test --locked -p sevro --test run_graders valid_json_output_accepts_130_levels_of_nesting -- --exact`
  accepts the independently observed nested-array document without imposing a
  Rust value-deserialization depth limit.
- `cargo test --locked -p sevro --test run_graders valid_json_configuration_requires_a_boolean_before_candidate_execution -- --exact`
  refuses `validJson: "yes"` with exit 64 and `validJson must be a boolean`,
  before the real adapter executes or result evidence is created.

JSON validity uses the existing pinned serde JSON syntax deserializer with
`IgnoredAny`, without converting JSON numbers or string escape sequences into
Rust values. No dependency or source-coverage exclusion was added.

## JSON validity checkpoint

`cargo test --locked -p sevro --test run_graders` passed all 22 tests: the six
existing exact-output and aggregation cases plus the 16 JSON-validity cases.
Strict workspace Clippy, workspace formatting and `bun run check:docs` passed.

The broader command `cargo test --locked -p sevro --test run_graders --test
run_repository --test run_dry --test run_extension --test run_results --test
run_required_evidence` passed the grader, dry and extension suites (22, one and
20 tests). It then stopped with 38 repository tests passing and the fixture
owner's new `overlay::rejects_the_next_overlay_byte_including_utf8_path_bytes`
case failing on its direct-file diagnostic. That run is not a combined passing
checkpoint. The fixture owner repaired that independently observed failure
after ownership of `preparation.rs` returned to them.

The previously unexecuted suites were then run with `cargo test --locked -p
sevro --test run_results --test run_required_evidence`; all ten tests passed.
Repository acceptance on the final shared sources belongs to the fixture
owner's verification and the coordinator's frozen candidate checkpoint.

## JSON pointer selection

The unchanged TypeScript CLI accepts `sevro.output` with `jsonPath: "/status"`
and no equality or containment assertion. A complete `{"status":"ready"}`
message yields completed execution and grading, a passed task, exit 0, and one
check with detail `ok` and a final-message evidence reference.

- Red — `cargo test --locked -p sevro --test run_graders json_path_selects_a_present_field -- --exact`:
  Rust refused the supported `jsonPath` configuration with exit 64.
- Green — `cargo test --locked -p sevro --test run_graders json_path_selects_a_present_field -- --exact`:
  one test passed after pointer declaration validation and raw object-member
  selection were added. It checks the independent literal digest, original
  message bytes and consistent CLI, run, trial, result and latest evidence.

The following tests were added and run one at a time in this order. The
TypeScript CLI independently established their literal verdicts, details and
retained evidence. Initial greens are characterizations, not claimed repairs.

- Initial green — `cargo test --locked -p sevro --test run_graders json_path_missing_field_fails_with_retained_observation -- --exact`: one test passed; `{}` yields exit 1 and `JSON pointer does not resolve`, retaining the original output.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_cannot_traverse_a_scalar -- --exact`: one test passed; a child of the scalar status cannot resolve.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_empty_pointer_selects_a_null_root -- --exact`: one test passed; the empty pointer selects a null document without inventing a missing observation.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_decodes_escaped_member_tokens -- --exact`: one test passed; `/a~1b/~0key` selects false from the actual escaped member names.
- Red — `cargo test --locked -p sevro --test run_graders json_path_selects_an_array_element -- --exact`: the object-only traversal returned exit 1 for a present array element instead of 0.
- Green — `cargo test --locked -p sevro --test run_graders json_path_selects_an_array_element -- --exact`: one test passed after raw array-element traversal.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_rejects_a_leading_zero_array_index -- --exact`: one test passed; `/items/00` does not resolve an array element.
- Red — `cargo test --locked -p sevro --test run_graders json_path_uses_the_last_duplicate_member -- --exact`: the first duplicate member hid the later present child, returning exit 1 instead of 0.
- Green — `cargo test --locked -p sevro --test run_graders json_path_uses_the_last_duplicate_member -- --exact`: one test passed after retaining the last matching raw member, as independently observed through JSON.parse.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_last_duplicate_can_remove_a_resolvable_child -- --exact`: one test passed; a final duplicate member containing null makes its former child unresolved.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_selects_a_child_of_a_later_array_element -- --exact`: one test passed; `/items/1/status` traverses past a null element to the actual nested member.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_invalid_json_fails_before_selection -- --exact`: one test passed; non-JSON text reports `output is not valid JSON` before attempting selection.
- Red — `cargo test --locked -p sevro --test run_graders json_path_selects_from_one_json_fence_with_surrounding_prose -- --exact`: raw-document-only selection returned exit 1 instead of 0.
- Green — `cargo test --locked -p sevro --test run_graders json_path_selects_from_one_json_fence_with_surrounding_prose -- --exact`: one test passed after sharing the existing single-fence recovery while leaving exact-document enforcement to validJson.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_missing_output_remains_unavailable -- --exact`: one test passed; a null message gives exit 4 without a fabricated evidence reference.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_partial_output_cannot_pass_selection -- --exact`: one test passed; a partial message gives exit 4 and retains its actual bytes and reference.
- Initial green — `cargo test --locked -p sevro --test run_graders valid_json_failure_precedes_json_path_selection -- --exact`: one test passed; the earlier exact-document stage reports `output is not exactly one JSON document` before the missing pointer.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_failure_precedes_exact_text_failure -- --exact`: one test passed; an unresolved pointer takes precedence over a simultaneous exact-text mismatch.
- Initial green — `cargo test --locked -p sevro --test run_graders exact_text_still_applies_after_json_path_selection -- --exact`: one test passed; successful selection still permits a later exact-text failure.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_rejects_invalid_escaping_before_candidate_execution -- --exact`: one test passed; invalid escaping returns exit 64 with `invalid JSON pointer`, without calling the adapter or creating results.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_requires_a_string_before_candidate_execution -- --exact`: one test passed; a numeric pointer returns exit 64 with `JSON pointer must be a string`, before execution.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_selects_a_number_beyond_finite_float_range -- --exact`: one test passed; the selected `1e400` number passes without finite-float conversion.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_selects_an_escaped_unpaired_surrogate -- --exact`: one test passed; the selected escaped lone-surrogate string passes with its original bytes and digest.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_traverses_130_levels_without_value_deserialization -- --exact`: one test passed; 130 array-selection steps pass without a recursive JSON value or its depth limit.

After these greens, array traversal was simplified to skip preceding values
then select the target, removing an unnecessary post-loop failure branch. The
public pointer regressions were rerun after that refactor.

Selection retains borrowed raw JSON subtrees. The existing serde JSON syntax
deserializer identifies value boundaries without converting selected numbers
or strings. No dependency or coverage exclusion was added. Configuration
strings retain the existing UTF-8 representation; this slice does not establish
all JavaScript Unicode behavior.

At this checkpoint, `cargo test --locked -p sevro --test run_graders --test
run_results --test run_required_evidence --test run_dry --test run_extension`
passed all 76 tests: 44 grader, five result, five required-evidence, one dry-run
and 21 extension tests. The 22 new pointer tests comprise four observed
red/green repairs and 18 initial-green characterizations. Strict workspace
Clippy passed. Scoped formatting of the three owned Rust files and the ledger's
Prettier and documentation checks passed. A workspace formatting check caught
other owners' concurrent test edits; formatting of that final shared candidate
remains the coordinator's checkpoint responsibility.

## JSON member and document boundaries

The unchanged TypeScript CLI supplied six independent baselines through a real
adapter. Each new Rust public CLI test below was added and executed separately.
All six passed on their first run; these are acceptance characterizations, with
no claimed red/green repair and no product-source changes. Each checks execution
and grading outcomes, retained run/trial evidence, original bytes and an
independent literal SHA-256 digest.

- Initial green — `cargo test --locked -p sevro --test run_graders json_path_skips_nonmatching_members_before_the_selected_member -- --exact`:
  one test passed; selects the later `status` member after an unrelated nested member, with exit 0 and detail `ok`.
- Initial green — `cargo test --locked -p sevro --test run_graders valid_json_output_rejects_malformed_json_inside_one_fence -- --exact`:
  one test passed; rejects malformed JSON inside one recognized fence with exit 1 and `output is not valid JSON`.
- Initial green — `cargo test --locked -p sevro --test run_graders valid_json_output_rejects_a_jsonc_language_tag -- --exact`:
  one test passed; rejects a `jsonc` language tag with exit 1 and `output is not valid JSON`.
- Initial green — `cargo test --locked -p sevro --test run_graders valid_json_output_accepts_a_mixed_case_json_language_tag -- --exact`:
  one test passed; accepts the mixed-case `JsOn` language tag and a trailing header tab, with exit 0.
- Initial green — `cargo test --locked -p sevro --test run_graders valid_json_output_does_not_trim_next_line_characters -- --exact`:
  one test passed; retains surrounding U+0085 NEXT LINE characters and fails exact-document matching with exit 1 and `output is not exactly one JSON document`.
- Initial green — `cargo test --locked -p sevro --test run_graders valid_json_output_trims_line_and_paragraph_separators -- --exact`:
  one test passed; trims surrounding U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR for exact-document matching, with exit 0.

The malformed-document and unsupported-tag cases remain completed assessments
with failed tasks, rather than preflight refusals or grading errors. The
whitespace cases preserve the TypeScript extractor's ECMAScript trimming
semantics. No pointer-property policy, declaration validation, dependency,
source guard or coverage denominator changed.

At this boundary checkpoint, `cargo test --locked -p sevro --test run_graders`
passed all 50 tests. `bun test tests/output-grader.test.ts
tests/output-grader-boundaries.test.ts` passed all 51 existing TypeScript tests.
`cargo clippy --locked -p sevro --bin sevro --test run_graders -- -D warnings`,
scoped Rustfmt, ledger Prettier and `bun run check:docs` passed. The coordinator
owns combined candidate coverage measurement; these test results do not claim
a new coverage percentage.

## Standalone regex grading

The unchanged TypeScript CLI ran the original `examples/basic/graded.json`
bytes with a real deterministic adapter. A complete `ready` response passed
with exit 0, check `ready`, grader `sevro.regex`, detail `ok`, and the
`sevro.observation.final-message` reference. A complete `not ready` response
failed with exit 1 and `regex assertion failed`. Both retained consistent
CLI/run/trial/result/latest records and the original response bytes. The first
Rust slice uses the shipped case directly rather than rewriting its grader.

- Red — `cargo test --locked -p sevro --test run_graders standalone_regex_passes_the_shipped_graded_case -- --exact`:
  the unchanged Rust product returned exit 64 with `grader preparation is not yet supported in Rust: sevro.regex`, rather than the baseline's passed exit 0.
- Green — `cargo test --locked -p sevro --test run_graders standalone_regex_passes_the_shipped_graded_case -- --exact`:
  one test passed after adding the general regex preparation and evaluation path.
  It asserts the original case's literal verdict, detail, evidence reference,
  response digest, built-in grader identity, persisted result consistency and
  successful workspace cleanup.

The implementation pins [regress 0.12.0](https://docs.rs/regress/0.12.0/regress/)
with its UTF-16 feature. Its [documented ECMAScript matching
interfaces](https://github.com/ridiculousfish/regress) support Unicode and
legacy UCS-2 input, backreferences and lookarounds. Declaration preparation
validates JavaScript flags before compiling, retaining mandatory multiline
matching. The prepared output/regex enum is skipped during declaration
serialization, so compiled state does not enter check identity. Evaluation
uses the prepared variant without a missing-regex fallback or panic.

The following 21 controls were added and run one at a time after independent
TypeScript CLI observations. Every control passed on its first Rust run; no
additional product repair or claimed red was needed.

- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_mismatch_fails_the_shipped_graded_case -- --exact`:
  one test passed. The unchanged shipped regex case fails a complete mismatching response with exit 1, exact assertion detail, and retained original evidence.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_negation_passes_when_the_pattern_is_absent -- --exact`:
  one test passed. An absent negated pattern passes with exit 0 and detail ok.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_negation_fails_when_the_pattern_matches -- --exact`:
  one test passed. A present negated pattern fails with exit 1 and regex assertion failed.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_always_matches_in_multiline_mode -- --exact`:
  one test passed. Anchored matching accepts a middle line without a caller-supplied m flag.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_rejects_invalid_syntax_before_execution -- --exact`:
  one test passed. Malformed syntax returns invocation exit 64 and invalid regex pattern or flags before calling the candidate or creating results.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_rejects_unknown_configuration_before_execution -- --exact`:
  one test passed. Unknown configuration retains the exact unsupported check configuration diagnostic before execution.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_requires_a_string_pattern_before_execution -- --exact`:
  one test passed. A non-string pattern retains invalid regex check configuration and prevents candidate execution.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_requires_boolean_negation_before_execution -- --exact`:
  one test passed. A non-boolean negate value is refused as invalid regex check configuration before execution.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_requires_string_flags_before_execution -- --exact`:
  one test passed. Non-string flags retain the wrapped invalid regex pattern or flags diagnostic before execution.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_rejects_a_duplicate_mandatory_multiline_flag -- --exact`:
  one test passed. Caller m duplicates the mandatory m and fails preflight rather than being silently deduplicated.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_rejects_unknown_flags_before_execution -- --exact`:
  one test passed. Unknown flag q is refused before execution instead of being ignored by the engine.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_rejects_conflicting_unicode_flags_before_execution -- --exact`:
  one test passed. Combined u and v flags fail preflight with the exact baseline diagnostic.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_global_matching_resets_for_each_trial -- --exact`:
  one test passed. Three real sequential trials all pass global matching, retaining each actual ready receipt and resetting the matcher between observations.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_sticky_matching_accepts_the_start -- --exact`:
  one test passed. Sticky matching accepts a match at the reset index zero.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_sticky_matching_rejects_a_later_match -- --exact`:
  one test passed. Sticky matching rejects an otherwise matching substring after index zero.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_without_unicode_uses_utf16_code_units -- --exact`:
  one test passed. Without u or v, an astral character occupies two code units and fails anchored single-dot matching.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_unicode_combines_a_surrogate_pair -- --exact`:
  one test passed. With u, the same astral character matches one anchored dot as a Unicode code point.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_supports_lookarounds_and_backreferences -- --exact`:
  one test passed. A captured repeated word constrained by lookbehind and lookahead passes through the actual evaluator.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_unicode_sets_accepts_the_intersection -- --exact`:
  one test passed. UnicodeSets v accepts ASCII letters in the ASCII/Letter class intersection.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_unicode_sets_rejects_values_outside_the_intersection -- --exact`:
  one test passed. UnicodeSets v rejects ASCII digits outside the same ASCII/Letter intersection.
- Initial green — `cargo test --locked -p sevro --test run_graders standalone_regex_supports_indices_case_insensitive_and_dot_all_flags -- --exact`:
  one test passed. Combined d, i and s flags accept a lowercase response with a newline matched by dot, retaining its original bytes.

These checks retain actual response bytes and literal independent digests for
completed assessments. Preflight checks assert the exact structured invocation
result, diagnostic, absent candidate-call marker and absent results directory.
The global control checks three real sequential candidate receipts. The finite
cohort does not claim complete ECMAScript syntax or Unicode-version parity;
configuration strings still use the port's existing UTF-8 representation.

After the finite regex cohort, `cargo test --locked -p sevro --test run_graders`
passed all 72 tests. `cargo clippy --locked -p sevro --bin sevro --test
run_graders -- -D warnings` passed. This includes the original 50 grader tests,
the shipped-case red/green slice and 21 initial-green regex controls. The
coordinator owns combined candidate acceptance and coverage; this focused run
does not establish a new coverage percentage.

## RFC 6901 decision controls

The accepted [JSON pointer compatibility decision](rust-fixtures-graders-parity.md#rust-json-pointer-compatibility-decision)
supersedes the earlier JavaScript property and last-duplicate-member behavior.
Its authority is the user's choice to follow RFC 6901. The historical
TypeScript observations and earlier red/green results above remain evidence
of the implementation at those checkpoints, not the current selected policy.
In particular, the earlier `json_path_uses_the_last_duplicate_member` outcome
is explicitly superseded: RFC 6901 section 4 requires the referenced object
member name to be unique. The current test is named
`json_path_rejects_a_duplicate_selected_member`.

- Initial green — `cargo test --locked -p sevro --test run_graders json_path_does_not_select_an_inherited_constructor -- --exact`:
  one test passed. An absent own constructor member does not resolve; completed grading fails the task with exit 1.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_does_not_select_an_array_length -- --exact`:
  one test passed. An array's synthetic length property does not resolve; completed grading fails the task with exit 1.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_selects_an_explicit_constructor_member -- --exact`:
  one test passed. An explicit JSON member named constructor remains selectable and passes with exit 0.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_selects_an_explicit_length_member -- --exact`:
  one test passed. An explicit JSON object member named length remains selectable and passes with exit 0.
- Red — `cargo test --locked -p sevro --test run_graders json_path_rejects_a_duplicate_selected_member -- --exact`:
  the unchanged selector returned passed exit 0 for a selected duplicate name,
  while the accepted RFC decision requires failed exit 1.
- Green — `cargo test --locked -p sevro --test run_graders json_path_rejects_a_duplicate_selected_member -- --exact`:
  one test passed after rejecting a second member matching the selected token.
  Grading remains completed with a failed task, exit 1 and
  `JSON pointer does not resolve`; original response evidence is retained.
- Initial green — `cargo test --locked -p sevro --test run_graders json_path_selects_a_member_despite_unrelated_duplicate_names -- --exact`:
  one test passed. Duplicate `ignored` members do not prevent the unique
  selected `status` member from passing with exit 0.

The existing failure with the child in the first duplicate member is now named
`json_path_rejects_an_ambiguous_member_before_child_selection`; its expected
failed outcome is unchanged and represents member ambiguity under the accepted
decision. The ordinary distinct-member positive controls remain. Selection
rejects only a repeated name matching the current pointer token; JSON syntax
acceptance and unrelated duplicate members are unchanged. The six decision
controls retain exact statuses, final-message references, raw bytes and
independent digests, consistent run/trial/result/latest records, and the
appropriate retained or cleaned workspace.

After this decision cohort, `cargo test --locked -p sevro --test run_graders`
passed all 77 tests, including the renamed ambiguity test and existing ordinary
member controls. `cargo clippy --locked -p sevro --bin sevro --test run_graders
-- -D warnings` passed. Five decision controls were initial green, and selected
duplicate rejection had the observed red/green repair above. Combined candidate
acceptance and coverage remain the coordinator's checkpoint responsibility.

## Selected JSON equality

The first equality slice uses the retained unchanged TypeScript public CLI
observation for `jsonPath: "/status"` with `expectJson: "ready"` and actual
response `{"status":"ready"}`. Its expected outcome is completed execution and
grading, passed task, exit 0, detail `ok`, and the actual final-message evidence
reference. Grader fixtures use process/counter-specific input and result roots;
candidate workspaces have unique UUID names. Test cleanup removes only those
owned paths. This cohort uses the separate Cargo target directory
`/tmp/sevro-json-equality-target.wIdMAq` so native-host compilation can proceed
independently.

- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_passes_a_selected_string -- --exact`:
  the unchanged product returned exit 64 with `output check configuration is not yet supported in Rust: expectJson`, rather than passed exit 0.
- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_passes_a_selected_string -- --exact`:
  one test passed after enabling selected-string equality through the existing
  raw document and pointer selection path.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_rejects_a_different_string -- --exact`:
  one test passed; a different selected string fails with exit 1 and
  `JSON value did not equal expectation` while retaining its response evidence.
- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_requires_a_pointer_before_execution -- --exact`:
  the declaration without `jsonPath` incorrectly ran the candidate and passed
  with exit 0 instead of the TypeScript preflight exit 64.
- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_requires_a_pointer_before_execution -- --exact`:
  one test passed after requiring a declared pointer before candidate admission.
- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_compares_numeric_values_instead_of_number_spelling -- --exact`:
  the string-only comparator failed `1.0` against expected numeric `1`, giving
  exit 1 instead of the independent TypeScript passed exit 0.
- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_compares_numeric_values_instead_of_number_spelling -- --exact`:
  one test passed after comparing JavaScript numeric values while preserving
  the sign of zero.
- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_compares_ordered_arrays_of_json_values -- --exact`:
  the scalar comparator failed the expected array of false, null, a number and
  a string with exit 1 instead of the TypeScript passed exit 0.
- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_compares_ordered_arrays_of_json_values -- --exact`:
  one test passed after comparing borrowed array members through an iterative
  worklist, including their JSON primitive values.
- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_compares_objects_without_property_order -- --exact`:
  an equivalent object with reordered properties and a nested array failed
  with exit 1 instead of the independent TypeScript passed exit 0.

- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_compares_objects_without_property_order -- --exact`:
  one test passed after comparing borrowed object members, independent of
  property order, through the same iterative worklist.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_distinguishes_negative_zero -- --exact`:
  one test passed. Selected -0 does not equal expected 0, matching the retained actual TypeScript oracle.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_does_not_replace_a_lone_surrogate -- --exact`:
  one test passed. Escaped lone surrogate remains valid JSON but fails equality with U+FFFD; raw response is unchanged.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_treats_large_exponents_as_equality_mismatches -- --exact`:
  one test passed. Accepted 1e400 output fails equality with finite expected 1 without becoming invalid JSON.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_preserves_array_order_and_element_types -- --exact`:
  one test passed. Reordered mixed array fails equality with retained original bytes.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_rejects_extra_object_properties -- --exact`:
  one test passed. An extra own member makes object equality fail with exact completed-assessment evidence.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_distinguishes_explicit_null_from_no_expectation -- --exact`:
  one test passed. A declared null expectation at the root rejects false; null is not interpreted as an absent option.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_compares_parsed_object_values_after_unique_selection -- --exact`:
  one test passed. After selecting unique item, whole-object equality retains JSON.parse last-member normalization inside that value; RFC selected-name ambiguity remains rejected by existing controls.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_selects_through_130_raw_array_levels -- --exact`:
  one test passed. Equality selects through 130 raw array levels without narrowing accepted document depth.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_failure_precedes_exact_output_failure -- --exact`:
  one test passed. When equality and exact text both fail, equality detail is the first failure.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders json_expectation_keeps_matching_partial_output_unavailable -- --exact`:
  one test passed. Matching partial JSON remains unavailable/not_assessed with exit 4, actual partial bytes and the evidence reference.

All sixteen new controls use a real deterministic adapter and the public CLI.
The executed controls assert literal status, detail, raw-response SHA-256,
final-message references, consistent run/trial/result/latest records, and
appropriate retained or cleaned workspaces. The missing-pointer control
asserts exact preflight output and absent candidate-call/results paths.
Independent unchanged TypeScript CLI observations precede each new behavior;
the accepted RFC decision continues to govern pointer traversal.

Equality uses borrowed raw values and an iterative worklist instead of
deserializing the candidate document into a recursive typed value. Numeric
comparison preserves JavaScript number-value equality and signed zero. Lone
surrogate values and overflowing numeric syntax remain valid JSON even when
they cannot equal the configured expectation. Object comparison uses own
decoded keys and the last parsed value for duplicate names inside the selected
value, matching JSON.parse; this does not change RFC pointer traversal, which
still rejects a duplicate referenced name. Existing configuration strings and
numbers retain the port's current UTF-8 and finite-value representation limits.
No new dependency was introduced.

After the equality cohort, `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq
cargo test --locked -p sevro --test run_graders` passed all 93 tests: the
previous 77 controls and 16 new equality controls. Five new tests had observed
red/green repairs; eleven were initial-green characterizations. This focused
run preserves the existing regex, RFC pointer and JSON-document controls.
`cargo clippy --locked -p sevro --bin sevro --test run_graders -- -D warnings`
passed with the same isolated target directory, and the three owned Rust files
passed scoped Rustfmt checks.
Combined candidate acceptance and coverage remain the coordinator's
checkpoint responsibility.

## Standalone JSON and recursive containment

This cohort follows the [built-in grader contract](../builtin-graders-v1.md),
the existing JSON and recursive-containment integration assertions in
`tests/output-grader.test.ts` and `tests/output-grader-boundaries.test.ts`,
and the accepted [RFC pointer decision](rust-fixtures-graders-parity.md#rust-json-pointer-compatibility-decision).
Each behavior was independently observed through the unchanged TypeScript CLI
with a real deterministic adapter before its Rust case. The first example
selects `/items/0` from one JSON fence and compares
`{"name":"alpha","tags":["a","b"]}`. It passes with completed execution and
grading, exit 0, detail `ok`, and the final-message evidence reference.

All tests use the existing isolated fixture roots and Cargo target from the
equality cohort. They assert public result status and exact detail, raw bytes
and independent digests where present, run/trial/result/latest consistency,
and retained or cleaned owned workspaces. Preflight tests assert the exact
structured refusal and absence of candidate-call and results paths.

- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_compares_a_selected_value -- --exact`:
  The unchanged product refused the supported grader with exit 64 instead of the TypeScript passed exit 0.
- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_compares_a_selected_value -- --exact`:
  one test passed. The selected JSON value passes with exit 0 after recovery from an actual fence.
- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_exact_document_rejects_surrounding_prose -- --exact`:
  The product refused exactDocument with exit 64 instead of assessing the prose-wrapped fence as failed with exit 1.
- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_exact_document_rejects_surrounding_prose -- --exact`:
  one test passed. Surrounding prose yields completed grading, a failed task and exit 1.
- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_contains_recursive_object_and_array_subsets -- --exact`:
  The product refused contains with exit 64 instead of passing the recursive subset with exit 0.
- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_contains_recursive_object_and_array_subsets -- --exact`:
  one test passed. Recursive object and array subsets pass with exit 0 after recovering one fence with prose.
- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders output_contains_json_matches_a_selected_array_member -- --exact`:
  The product refused containsJson with exit 64 instead of passing the selected array member with exit 0.
- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders output_contains_json_matches_a_selected_array_member -- --exact`:
  one test passed. Selected-array containment passes with exit 0 despite extra member fields.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_containment_requires_every_nested_array_part -- --exact`:
  one test passed. A missing nested blue tag yields completed grading and exit 1, retaining the exact containment detail and response.
- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_contains_precompiled_string_regex_subsets -- --exact`:
  The product assessed the valid regex subset as failed with exit 1 instead of passing with exit 0.
- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_contains_precompiled_string_regex_subsets -- --exact`:
  one test passed. Typed subset matching now passes with exit 0. A subsequent refactor to avoid indexing the pattern map also passed the identical command.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_rejects_invalid_nested_regex_before_execution -- --exact`:
  one test passed. A nested malformed regex refuses with exit 64 and invalid subset regex before candidate execution or result allocation.
- Red — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_subset_regex_preserves_lone_utf16_surrogates -- --exact`:
  String deserialization made the accepted escaped lone-surrogate regex case fail with exit 1 instead of passing with exit 0.
- Green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_subset_regex_preserves_lone_utf16_surrogates -- --exact`:
  one test passed. Decoding a validated JSON string into UTF-16 units preserves the accepted lone surrogate and passing regex observation.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_subset_regex_does_not_add_multiline -- --exact`:
  one test passed. Anchored subset regex does not acquire standalone regex's implicit multiline flag.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders output_contains_json_requires_pointer_before_subset_compilation -- --exact`:
  one test passed. A missing output jsonPath refuses with exit 64 before compiling an invalid nested subset regex.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders standalone_json_containment_keeps_missing_output_unavailable -- --exact`:
  one test passed. Missing output keeps containment unavailable/not_assessed with exit 4 and no fabricated raw bytes or final-message reference.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders output_contains_json_keeps_matching_partial_output_unavailable -- --exact`:
  one test passed. Matching partial output remains unavailable/not_assessed with exit 4, retained partial bytes and the final-message reference.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders output_json_equality_failure_precedes_containment_and_exact_text -- --exact`:
  one test passed. Simultaneous equality, containment and exact-text failures retain the equality detail first.
- Initial green — `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq cargo test --locked -p sevro --test run_graders output_json_containment_failure_precedes_exact_text_after_equality -- --exact`:
  one test passed. After equality passes, containment failure detail precedes simultaneous exact-text failure.

The subset is compiled before execution into typed scalar, object, array and
regex variants. Its compiled state is skipped during declaration serialization,
preserving the evaluator-owned identity input. Regex subsets reuse the pinned
engine with no flags; they do not inherit standalone regex's mandatory
multiline mode. Matching decodes only an already-validated raw JSON string into
UTF-16 units, retaining escaped unpaired surrogates without requiring a Rust
Unicode scalar string. Pattern preparation returns typed errors and does not
defer compilation to candidate assessment.

Ordinary object subset matching compares parsed JSON members; nested arrays
require each expected part to match some actual member. Selected arrays need
at least one matching member. JSON equality precedes containment, and both
precede exact text. Raw document selection and referenced-member uniqueness
remain the existing RFC path. This cohort does not redefine unrelated
JavaScript inherited-property behavior in containment or claim those
source-only cases as resolved parity. Existing configuration representation
limits remain; no dependency, helper module, schema grader or other family was
added.

After this cohort, `CARGO_TARGET_DIR=/tmp/sevro-json-equality-target.wIdMAq
cargo test --locked -p sevro --test run_graders` passed all 107 tests: 93 prior
controls and 14 new JSON/containment controls. Six new tests had observed
red/green repairs; eight were initial-green characterizations. Scoped
`cargo clippy --locked -p sevro --bin sevro --test run_graders -- -D warnings`
and owned-file Rustfmt checks passed with the same target. Combined candidate
acceptance and coverage remain the coordinator's checkpoint responsibility.

## Remaining boundaries

This ledger covers `sevro.output` with `expectExact`, `validJson`, ordinary
`jsonPath` selection with `expectJson` equality and `containsJson` containment,
standalone `sevro.json`, and the standalone `sevro.regex` controls above.
JSON object and array selection follows
the accepted RFC 6901 decision, including referenced-member uniqueness. Other
deterministic checks, custom graders, domain outcomes, semantic grading and
complete aggregation parity remain separate work. The
coordinator's exact candidate CI remains pending.

At the initial exact-output checkpoint, `cargo test --locked -p sevro --test run_graders`
passed all six tests, `cargo clippy --workspace --all-targets --locked -- -D
warnings` passed, the owned Rust files were formatted, and `bun run check:docs`
passed.
