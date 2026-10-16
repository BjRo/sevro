# Rust report CLI TDD evidence

The public seam is the existing `sevro report` command. Integration tests spawn
the compiled Rust executable against independently authored retained v1 JSON
documents in temporary directories. Expected reports are literal examples from
the [protocol/results parity specification](rust-protocol-results-parity.md).
No model host, private production function, or production validator supplies
the expected report.

Commands run from the worktree root with Rust 1.99.0 selected and the discovered
toolchain's `cargo/bin` on PATH. `CARGO_HOME` and `RUSTUP_HOME` point to the
corresponding directories under
`/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain`.
The commands below are the literal Cargo commands executed through lean-ctx.

## One retained graded case as JSON

- Red — `cargo test -p sevro --test report reports_one_retained_case_as_json -- --exact`:
  the CLI stub returned exit 64; the fixture requires exit 0 and an exact
  `sevro.report.v1` document with measured duration, usage, route, and identity.
- Implementation validation initially found an iterator mutability compiler
  error, which was fixed. Concurrent CLI work temporarily referenced a missing
  help text file; that build failure is not behavioral red evidence.
- The initial expected path used macOS's `/var` alias while the CLI correctly
  canonicalized it to `/private/var`. The fixture now canonicalizes its root.
- Green — `cargo test -p sevro --test report reports_one_retained_case_as_json -- --exact`:
  one test passed with exact JSON output and empty stderr.

## Default Markdown presentation

- Red — `cargo test -p sevro --test report reports_readable_markdown_by_default -- --exact`:
  default output was JSON instead of the required Markdown heading and rows.
- Green — `cargo test -p sevro --test report reports_readable_markdown_by_default -- --exact`:
  one test passed, including duration, tokens, cost, evidence and route rows.

## Published schema enforcement

- Red — `cargo test -p sevro --test report refuses_documents_outside_the_published_schemas -- --exact`:
  accepted a result declaring `foreign.v1` and returned exit 0 instead of 64.
- Corrected the independent valid fixture to include the published required
  check `grader` field before running acceptance against the real schemas.
- Green — `cargo test -p sevro --test report refuses_documents_outside_the_published_schemas -- --exact`:
  one table-driven test passed for invalid formats, states, enums, extra fields,
  digest spelling, numeric bounds and nested instrumentation. Three existing
  report tests also passed with the embedded schemas enabled.

## Retained cross-record integrity

- Red — `cargo test -p sevro --test report refuses_inconsistent_retained_evidence -- --exact`:
  a result whose evidence omitted its trial was accepted and fabricated zero
  aggregates instead of returning exit 64.
- Green — `cargo test -p sevro --test report refuses_inconsistent_retained_evidence -- --exact`:
  missing, duplicate and wrong-number trials, wrong run, missing/duplicate
  candidate route, and changed embedded result all refuse without JSON stdout.

## Zero and unknown measurements

- Red — `cargo test -p sevro --test report distinguishes_measured_zero_from_unknown_usage_and_historical_duration -- --exact`:
  incomplete usage reported numeric zero input tokens instead of null.
- Green — `cargo test -p sevro --test report distinguishes_measured_zero_from_unknown_usage_and_historical_duration -- --exact`:
  complete zeros remain zero; incomplete usage and historical absent duration
  remain null and render as unknown in Markdown.

## Unassessed rates

- Red — `cargo test -p sevro --test report leaves_unassessed_pass_rates_unknown -- --exact`:
  prompt-only execution reported pass rate 0 instead of null.
- Green — `cargo test -p sevro --test report leaves_unassessed_pass_rates_unknown -- --exact`:
  prompt-only, dry and empty trial sets keep rates unknown; empty trial sets
  also keep duration unknown instead of inventing zero.

## Pre-run failures

- Red — `cargo test -p sevro --test report reports_prerun_failure_without_inventing_case_evidence -- --exact`:
  valid pre-run exit 64 with no evidence was rejected as a missing string.
- Green — `cargo test -p sevro --test report reports_prerun_failure_without_inventing_case_evidence -- --exact`:
  JSON and Markdown retain the failure input without case rows; an alleged
  successful run without retained evidence still refuses.

## Domain outcomes and labels

- Red — `cargo test -p sevro --test report reports_domain_outcomes_separately_and_escapes_markdown_labels -- --exact`:
  a retained unavailable domain outcome was discarded from the report row.
- Green — `cargo test -p sevro --test report reports_domain_outcomes_separately_and_escapes_markdown_labels -- --exact`:
  passed and failed task verdicts remain independent of domain outcomes;
  Markdown includes the separate table and escapes case/route pipe/newline labels.

## Result source selection

- Red — `cargo test -p sevro --test report selects_latest_or_explicit_results_and_rejects_ambiguous_sources -- --exact`:
  `--latest` was rejected as unknown.
- Green — `cargo test -p sevro --test report selects_latest_or_explicit_results_and_rejects_ambiguous_sources -- --exact`:
  default/custom latest roots, relative explicit files and equals flag syntax
  work; missing/conflicting/unknown arguments and canonical duplicate inputs refuse.

## Retained evidence paths and decoding

- Red — `cargo test -p sevro --test report refuses_missing_unreadable_or_relative_retained_evidence -- --exact`:
  a relative evidence path was accepted when it happened to exist in cwd.
- Green — `cargo test -p sevro --test report refuses_missing_unreadable_or_relative_retained_evidence -- --exact`:
  relative, null, missing, malformed JSON and non-UTF-8 evidence refuse with
  exit 64 and no successful JSON output.

## Aggregate characterization

`cargo test -p sevro --test report preserves_run_case_order_and_sums_only_complete_trial_measurements -- --exact`
passed on its first run. This is additional acceptance coverage, not claimed
red/green evidence: the earlier implementation already handled generic loops.
Two runs with repeated case IDs preserve three rows in input/case order. Two
trials independently require rate 0.5, duration 2000 ms, input/output tokens
20/10 and cost 0.003. Candidate/semantic/advisory routes remain visible; an
absent provider cost stays null while known tokens remain measured. No product
code changed for this characterization.

## Canonical numeric equality

- Red — `cargo test -p sevro --test report accepts_canonical_numeric_equivalence_in_retained_results -- --exact`:
  equivalent embedded results using negative zero and integer-valued decimals
  were rejected by Rust structural number equality.
- Green — `cargo test -p sevro --test report accepts_canonical_numeric_equivalence_in_retained_results -- --exact`:
  JCS comparison accepts equivalent result bytes and numerically equal trial
  references while the mismatch refusal suite remains required.

## Fixed-decimal presentation

- Red — `cargo test -p sevro --test report markdown_rounds_exact_decimal_halves_like_the_existing_report -- --exact`:
  Rust's ties-to-even formatting produced 12%, 1.12s and $0.0312 instead of
  the existing report's 13%, 1.13s and $0.0313.
- Green — `cargo test -p sevro --test report markdown_rounds_exact_decimal_halves_like_the_existing_report -- --exact`:
  exact binary half cases now follow ECMAScript's larger-decimal rule without
  introducing a second floating-point rounding step.

## Large-measurement presentation

- Red — `cargo test -p sevro --test report markdown_uses_ecmascript_exponents_for_large_measurements -- --exact`:
  Rust fixed formatting printed full decimal integers where the existing
  report's ECMAScript `toFixed` switches to exponent notation at `1e21`.
- Green — `cargo test -p sevro --test report markdown_uses_ecmascript_exponents_for_large_measurements -- --exact`:
  the literal Markdown row contains `1e+21s`, `1e+21 / 1e+21` tokens and
  `$1e+21`. The threshold delegates number spelling to the existing JCS library.

## Overflowing aggregate refusal

An independently authored valid retained result with two finite `1e308`
durations was first checked through `bun src/cli.ts report --json --result-file`.
The existing CLI returned exit 64, empty stdout and `invalid Sevro report` on
stderr because the aggregate cannot be represented as a finite JSON number.

- Red — `cargo test -p sevro --test report refuses_overflowing_measured_totals_instead_of_fabricating_unknown -- --exact`:
  the Rust CLI returned exit 0 with `candidateDurationMs: null`, replacing a
  measured but overflowing sum with an unknown measurement.
- Green — `cargo test -p sevro --test report refuses_overflowing_measured_totals_instead_of_fabricating_unknown -- --exact`:
  duration, input token, output token and cost overflow each refuse with exit 64
  and no successful report. Genuinely absent measurements still remain unknown.

## Final gates

The legacy TypeScript gates and GitHub CI remain separately required by the
repository contribution contract. The coordinator runs combined compiler
coverage and validates the published candidate.

- `cargo clippy --workspace --all-targets --locked -- -D warnings` passed.
- `cargo test -p sevro --test report --locked` passed all 15 tests.
- `cargo fmt --all -- --check` passed.
- `bun run check:docs` passed. Remote CI remains the coordinator's gate.
