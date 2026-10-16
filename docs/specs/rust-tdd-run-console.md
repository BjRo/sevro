# Rust run console summaries

These slices preserve ordinary single-trial success and failed-check human
output through the public executable, without `--json`. They follow the
[results contract](../results-v1.md) and is exercised by
[`run_console.rs`](../../crates/sevro/tests/run_console.rs).

## Independent baseline

The unchanged TypeScript CLI executed a real adapter returning `ready`, complete
usage of 12 input and 3 output tokens, and cost 0.25. The inline case's one exact
output check expected `ready`. The process exited 0. Its stdout had five lines,
in this order:

```text
execution=completed grading=completed task=passed
trial case=console-ready trial=1 execution=completed grading=completed task=passed
case=console-ready candidate duration=0.38ms candidate tokens=12/3 cost=$0.2500
result=<absolute result.json path>
evidence=<absolute run.json path>
```

The measured `0.38ms` belongs to that original baseline execution. The durable
test requires a finite nonnegative `candidateDurationMs` in the retained public
evidence, then compares the complete stdout with that actual measurement
formatted to two decimals. This is a cross-artifact consistency assertion,
not a fixed clock expectation or removal of the duration line. Tokens and cost
remain literal fixture expectations. Only the exact retained result/evidence
paths, including their generated run ID, are normalized. No status, case ID,
usage, punctuation, whitespace, or line order is normalized.

Stdout and stderr are captured separately. The test confirms that effective
settings remain on stderr and completion lines remain on stdout. It does not
claim full parity for every progress-stage message.

The external baseline script is `/tmp/sevro-console-baseline.py`; its original
command, stdout, and stderr are retained in the
`sevro-console-baseline-keqvl_hj` temporary directory.

## Red and green

- Red — `cargo test -p sevro --test run_console successful_exact_output_run_prints_the_observed_completion_summary --locked -- --exact`:
  Rust printed only aggregate states and the evidence path. The exact public
  assertion exposed the missing trial, measurement, and result-path lines.
- Green — `cargo test -p sevro --test run_console successful_exact_output_run_prints_the_observed_completion_summary --locked -- --exact`:
  one test passed after the internal completion handoff carried its already
  validated retained evidence and optional published result path to the human
  renderer.

Public result and evidence schemas are unchanged. Measurements use actual
retained trials; incomplete usage remains unknown. A result/latest publication
failure does not invent a successful publication or a result-path line. The
existing nonzero outcome and diagnostic precedence remain in force.

The first test covered the successful exact-output summary. Failed-check details
were still pending at that boundary. The report command and report rendering
were not changed in that first slice.

Final local validation passed:

- `cargo test -p sevro --test cli --test run_adapter --test run_console --test run_results --test run_storage --locked`:
  all 38 tests passed, including existing JSON receipts, cancellation, and
  successful/nonzero publication-failure behavior.
- `cargo clippy --workspace --all-targets --locked -- -D warnings` passed.
- Scoped Rust formatting and `bun run check:docs` passed.

Candidate-wide coverage, independent review, and hosted macOS/Ubuntu checks
remain coordinator gates; this slice does not claim those gates are complete.

## Failed check and incomplete usage

The unchanged TypeScript CLI returned exit 1 for an exact check expecting
`ready` when the real adapter returned `PRIVATE_RESPONSE_DO_NOT_PRINT`. Its
check ID contained a tab and newline: `exact\toutput\ncheck`. The retained
check preserves those original characters, while human stdout includes:

```text
execution=completed grading=completed task=failed
trial case=console-failed trial=1 execution=completed grading=completed task=failed
  check=exact output check status=failed reason=exact output did not match
case=console-failed candidate duration=0.46ms candidate tokens=unknown/unknown cost=unknown
result=<absolute result.json path>
evidence=<absolute run.json path>
```

The adapter supplied 12 input tokens, unknown output tokens, cost 0.25, and
incomplete usage. Retained evidence keeps those partial measurements; the
summary displays the entire incomplete usage group as unknown. The baseline's
duration is historical; the durable test uses the same cross-artifact duration
and path-normalization rules as the first slice. Raw response bytes and the
failed workspace remain retained. Neither the private prompt nor the response
appears in stdout or stderr. Full stderr was captured separately; this test
checks channel separation and privacy, without claiming complete stage-message
parity.

The external command and outputs are retained in
`sevro-console-failure-baseline-mzdb58bu`; its `baseline-report.json` also
contains the actual public result and trial evidence.

- Red — `cargo test -p sevro --test run_console failed_exact_output_prints_sanitized_check_and_unknown_measurements --locked -- --exact`:
  all preceding retained-evidence assertions passed, but stdout omitted the
  sanitized failed-check line.
- Green — `cargo test -p sevro --test run_console failed_exact_output_prints_sanitized_check_and_unknown_measurements --locked -- --exact`:
  one test passed after the renderer emitted non-passing checks using its
  existing bounded console sanitizer.

## Exact decimal-half cost

A separate unchanged TypeScript CLI invocation accepted complete usage with
12 input tokens, 3 output tokens, and literal cost `0.03125`. It exited 0,
retained that exact cost, and printed `candidate tokens=12/3 cost=$0.0313`.
The original command, stdout, stderr, and result are retained in
`sevro-console-half-baseline-4xkn0_h7`. The durable console assertion uses the
literal `$0.0313` oracle, not a recomputed Rust cost formatter.

- Red — `cargo test -p sevro --test run_console complete_usage_rounds_decimal_half_cost_like_the_existing_console --locked -- --exact`:
  stdout printed `$0.0312` instead of the baseline's `$0.0313`; other summary
  lines and the retained complete usage passed.
- Green — `cargo test -p sevro --test run_console complete_usage_rounds_decimal_half_cost_like_the_existing_console --locked -- --exact`:
  one test passed after extracting the report renderer's existing ECMAScript
  fixed-decimal formatter into a shared module and using it for console
  duration and cost.

The formatter algorithm is unchanged. Existing report regressions for exact
decimal halves and large-number exponent formatting remain part of the
affected report suite. This slice does not establish large-number console
token formatting, domain-outcome summaries, or the full human-output matrix.
Public result and evidence schemas remain unchanged.

Final local validation for both follow-up slices passed:

- `cargo test -p sevro --test cli --test report --test run_adapter --test run_console --test run_results --test run_storage --locked`:
  all 60 tests passed, including all 17 report tests and 24 adapter tests.
- `cargo clippy --workspace --all-targets --locked -- -D warnings` passed.
- Scoped Rust formatting and `bun run check:docs` passed.

Candidate-wide measurement, independent review, and hosted checks remain
coordinator responsibilities; the focused results do not establish full port
completion.

## Host failure followed by latest-publication failure

The unchanged TypeScript CLI ran a real adapter that returned a failed host
receipt, a partial final message, and complete known usage of 12 input tokens,
3 output tokens, and cost 0.25. A pre-existing directory at
`results/latest.json` made publication fail. The process preserved exit 2 and
printed exactly these three stdout lines:

```text
execution=failed grading=not_requested task=not_assessed
trial case=console-publication trial=1 execution=failed grading=not_requested task=not_assessed
evidence=<absolute run.json path>
```

The result, run, trial, partial raw response, known usage, and failed workspace
were actually retained. The collision directory and its sentinel bytes remained
intact. Even though `result.json` existed and measurements were known, the
incomplete publication omitted both the result-path and measurement lines.
Only the actual evidence path is normalized in the durable stdout assertion.

Stderr ended with the publication warning followed by the original host
diagnostic, in this order:

```text
sevro: CLI result/latest could not be retained; original run outcome preserved; inspect evidence directly
sevro: controlled host failure
```

The private prompt and partial response remained absent from both output
streams. The external script is `/tmp/sevro-console-publication-baseline.py`;
the actual command, separate output streams, and retained-file observations
are recorded in `sevro-console-publication-baseline-1sumyp_6`.

- Initial green — `cargo test -p sevro --test run_console failed_host_publication_warning_preserves_plain_evidence_summary --locked -- --exact`:
  one test passed on its first execution against unchanged product code.
  This is a public compatibility characterization, not a fabricated red/green
  repair. It asserts the exact summary, original exit, warning ordering,
  privacy, partial raw bytes and literal hash, retained usage and duration,
  cross-file equality, failed workspace, and collision preservation.

No product source changed for this characterization.

Final local validation passed: `cargo test -p sevro --test run_console --locked`
ran all four console cases successfully. Scoped Rust formatting,
`cargo clippy --workspace --all-targets --locked -- -D warnings`, and
`bun run check:docs` also passed. Strict Clippy ran after the options owner's
concurrent temporary lint issue was resolved; no unrelated source was changed
for this test.
