# Rust extension CLI TDD evidence

The public seam is the existing `sevro run --extension-command-file ... --dry
--host codex` command. Tests spawn the compiled Rust binary and real trusted
extension subprocesses. Literal response bodies come from the
[extension contract](../extension-protocol-v1.md) and
[protocol parity specification](rust-protocol-results-parity.md); the fixture
imports no Sevro implementation or validator. Node runs the small independent
extension fixture and is an existing integration prerequisite.

Commands run from the worktree root with the pinned Rust toolchain selected.
The literal Cargo commands below were executed through lean-ctx with explicit
`CARGO_HOME`, `RUSTUP_HOME` and toolchain `cargo/bin` on PATH.

## One extension dry run

The existing TypeScript CLI was independently observed before implementation.
A valid fixture receives `describe`, `resolve` and `prepare` through three
fresh processes, each with a distinct correlation ID. It receives the selected
candidate route and explicit configuration. The CLI exits 0 while retaining
`not_run/not_requested/not_assessed`, negotiated capabilities, and actual
extension source/configuration identity. Prepared extension data contributes
to case identity. The dry path never calls `evaluate` or executes the candidate.

- Red — `cargo test -p sevro --test run_extension resolves_and_prepares_a_real_extension_for_a_native_dry_run -- --exact`:
  the Rust CLI returned exit 64 with `unsupported option in the Rust dry-run
slice: --extension-command-file`; the independent example requires exit 0.
- Green — `cargo test -p sevro --test run_extension resolves_and_prepares_a_real_extension_for_a_native_dry_run -- --exact`:
  one test passed after the case-source, preparation, identity and evidence
  hooks were integrated. Literal case/fixture digest vectors match the baseline.

The transport uses one UTF-8 JSON document followed by stdin EOF. A trailing
newline is optional; multiple response documents are invalid. This is the
existing protocol framing, not a new line-oriented protocol.

## Duplicate resolved cases

- Red — `cargo test -p sevro --test run_extension refuses_duplicate_resolved_case_ids_before_preparation -- --exact`:
  the CLI accepted duplicate IDs, prepared the first case and exited 0 instead
  of the existing protocol's exit 70 refusal.
- Green — `cargo test -p sevro --test run_extension refuses_duplicate_resolved_case_ids_before_preparation -- --exact`:
  one test passed; the error names duplicate case IDs and no prepare call occurs.

## Response validation characterization

`cargo test -p sevro --test run_extension rejects_invalid_protocol_responses_without_exposing_private_diagnostics -- --exact`
passed on its first run. This is acceptance characterization, not claimed
red/green evidence: the first session implementation already validated the
public schema, envelope correlation, protocol and capability selection.
Thirteen real subprocess scenarios cover malformed/extra/non-UTF-8 output,
echoed requests, wrong shapes/extra fields, protocol/ID/method mismatches,
incompatible protocols, missing required capabilities, private errors and
nonzero process exit. Failure results remain unassessed without retained run
paths, and private response messages/stderr markers do not escape.

## Source snapshots

- Red — `cargo test -p sevro --test run_extension refuses_declared_source_changes_during_discovery_or_resolution -- --exact`:
  an extension changed a declared source during discovery, yet the CLI
  continued through preparation and exited 0 with stale source identity.
- Green — `cargo test -p sevro --test run_extension refuses_declared_source_changes_during_discovery_or_resolution -- --exact`:
  one test passed for mutation during discovery and resolve. The CLI returns
  exit 70 with the applicable source-change diagnostic and no run evidence.

## Bounded stdout and diagnostic draining

- Red — `cargo test -p sevro --test run_extension bounds_stdout_messages_while_accepting_boundary_whitespace_and_draining_stderr -- --exact`:
  an otherwise valid response with 8 MiB plus one byte was accepted with exit 0.
- Green — `cargo test -p sevro --test run_extension bounds_stdout_messages_while_accepting_boundary_whitespace_and_draining_stderr -- --exact`:
  one test passed. Exactly 8 MiB including legal trailing whitespace succeeds;
  one extra byte refuses with the bounded-message diagnostic. Both cases drain
  250 KiB of private stderr without exposing its contents. Stdout capture now
  checks the byte limit while reading; retained stderr is capped at 64 KiB.

## Private and redacted configuration

The first attempt to run this regression encountered a concurrent native-host
compile error. That was repaired by its owner and is not behavioral red evidence.

- Red — `cargo test -p sevro --test run_extension passes_private_configuration_to_extensions_and_retains_only_redacted_identity -- --exact`:
  the CLI rejected the existing `--extension-configuration-file` option with
  exit 64 instead of running the configured extension.
- Green — `cargo test -p sevro --test run_extension passes_private_configuration_to_extensions_and_retains_only_redacted_identity -- --exact`:
  one test passed. Resolve/prepare receive the private configuration; run
  evidence retains only redacted values and their identity. Changing redacted
  values changes configuration identity, and an unpaired private file refuses.

## Outgoing request bound

- Red — `cargo test -p sevro --test run_extension refuses_an_oversized_request_before_launching_resolution -- --exact`:
  a resolve request larger than 8 MiB was sent and accepted, producing exit 0.
- Green — `cargo test -p sevro --test run_extension refuses_an_oversized_request_before_launching_resolution -- --exact`:
  one test passed. Only discovery runs; the oversized resolve request refuses
  before launching its process, with no fabricated retained run evidence.

## Default process deadline

A concurrent provenance initializer compile error was repaired before observing
the behavioral red below; it is not counted as test-first failure evidence.

- Red — `cargo test -p sevro --test run_extension enforces_the_default_deadline_until_the_extension_exits -- --exact`:
  an extension closed its pipes after a valid response but remained alive for
  31 seconds; the CLI waited and then returned success instead of timing out.
- Green — `cargo test -p sevro --test run_extension enforces_the_default_deadline_until_the_extension_exits -- --exact`:
  one test passed in approximately 30 seconds. The default deadline remains
  active until process exit, and timeout terminates the owned process group.

## Interruption during discovery

Before writing the regression, independent Bun CLI runs confirmed SIGINT and
SIGTERM during discovery both return exit 70, `sevro.runner.error` with
`extension request cancelled`, null retained paths and empty cases. This phase
precedes trial admission; its result must not be replaced with later trial
interruption's exit 130/143. A real descendant's delayed file write never occurs.

- Red — `cargo test -p sevro --test run_extension cancels_extension_discovery_and_its_descendants_on_cli_signals -- --exact`:
  SIGINT terminated the Rust CLI without JSON or an exit code, instead of the
  baseline's structured exit 70 refusal. The test cleans up its owned fixture
  group even on this intentionally failing run.
- Green — `cargo test -p sevro --test run_extension cancels_extension_discovery_and_its_descendants_on_cli_signals -- --exact`:
  one test passed for both signals. The shared invocation signal context retains
  the signal; extension transport returns the baseline structured refusal and
  kills the owned process group before its descendant can write a marker.

## Explicit extension selection over saved settings

Independent Bun CLI probes confirmed that an explicit extension selection removes
a saved case-file selection, and that explicit source files replace the saved
source list. Neither unselected input needs to exist.

- Red — `cargo test -p sevro --test run_extension explicit_extension_selection_replaces_saved_case_and_source_lists -- --exact`:
  exit 64 rejected simultaneous case/extension selections instead of using the
  explicit extension and returning 0.
- Green — the identical command passed both saved-case and saved-source-list
  scenarios after the CLI owner corrected manifest selection replacement.
  Evidence retains a null case file and exactly one selected extension source.

## Trusted command file validation

Independent Bun probes distinguish unreadable/malformed JSON from a parsed
value that is not an absolute nonempty argv array. Both refuse with exit 64
before discovery and do not print private file contents.

- Red — `cargo test -p sevro --test run_extension refuses_invalid_command_files_before_launching_discovery -- --exact`:
  malformed JSON returned the argv-shape diagnostic instead of the literal
  `extension command file is unreadable or invalid` diagnostic.
- Green — the identical command passed after separating JSON parsing from argv
  validation. The regression also covers missing files, empty argv, empty
  arguments, relative executables, non-string elements and an object value.

## Configuration validation order and privacy

Independent Bun probes confirmed both files are parsed before validating their
object shapes. Thus a private array paired with malformed redacted JSON reports
the redacted file parse failure first.

- Red — `cargo test -p sevro --test run_extension refuses_invalid_configurations_without_exposing_file_contents -- --exact`:
  Rust reported the private object's shape first instead of the redacted parse
  failure.
- Green — the identical command passed after moving the joint object check
  after both file reads. Seven controls cover missing/malformed private and
  redacted inputs, arrays/null, refusal before discovery and private-content
  suppression.

## Supported capabilities and schema boundaries

The following public subprocess controls passed on their first run and are
characterization evidence, not claimed missing-behavior red/green slices:

- `negotiates_supported_optional_capabilities_once_in_declared_order` retains
  required capabilities first, adds supported optional capabilities once and
  ignores unsupported optional declarations.
- `refuses_uncorrelated_or_invalid_preparation_before_retaining_evidence`
  checks a schema-valid response from another protocol, absent selected case,
  invalid prepared data and missing resolved data.
  Independent Bun probes established each literal diagnostic and exit status.
- `enforces_declared_source_closure_and_request_schema` checks duplicate and
  unreadable sources, an overlong selector rejected before resolution, and an
  explicitly listed executable counted once in the source digest closure.

After the schema controls passed, the preparation context's impossible second
shape-validation errors became explicit validated invariants. The exchange
validator still rejects invalid external data before it reaches this context;
the identical refusal regression remained green after that refactoring.

## Unsupported native instrumentation

- Red — `cargo test -p sevro --test run_extension refuses_instrumentation_the_native_host_does_not_support -- --exact`:
  Rust exposed an implementation-placeholder diagnostic for a request the
  native Codex host does not support, unlike the independent Bun baseline.
- Green — the identical command passed with exit 64 and the baseline diagnostic
  `extension preparation requested unsupported instrumentation`, before native
  execution or retained evidence. This does not establish adapter instrumentation
  support, which remains a separate capability path.

## UTF-8 byte-order mark compatibility

Independent Bun subprocess probes established that its UTF-8 decoder consumes
one leading byte-order mark. A mark after whitespace remains invalid JSON.

- Red — `cargo test -p sevro --test run_extension accepts_a_leading_utf8_bom_but_refuses_one_inside_the_json_document -- --exact`:
  a leading mark refused with exit 70 instead of completing the dry run.
- Green — the identical command passed after consuming only an initial UTF-8
  mark, within the existing byte limit. The embedded-mark control still refuses.

## Source selection invariants

The private Rust `Selection` has one construction site, in CLI options parsing.
It rejects missing/empty source declarations with exit 64 and canonicalizes each
selected path before opening a session. Consequently the session cannot receive
an empty source list or a relative path through the public CLI. The redundant
checks in `source_digest` were removed; duplicate canonical paths still produce
the same exit 70 protocol diagnostic, and executable inclusion, readable bytes,
digest comparison and change detection remain enforced.

This is a behavior-preserving refactoring, not a red/green claim. Both
`empty_extension_source_names_the_missing_input_before_loading_the_command` and
`enforces_declared_source_closure_and_request_schema` passed before and after.
The latter also exercises accepted relative CLI paths and executable closure
deduplication. A future public session API would need its own input validator;
the current session remains private to the validated run path.

## Simultaneous pipe cleanup and startup failure

Independent Bun CLI probes established these baseline diagnostics. The new
public subprocess controls passed on their first run:

- `rejects_output_overflow_while_the_extension_leaves_its_request_unread` starts
  resolution with a 1 MiB request. The extension leaves stdin unread and emits
  more than 8 MiB. Output rejection terminates the process, unblocks the pending
  writer and retains `extension message exceeds 8 MiB` as the first failure.
  The causal setup does not depend on competing timers or injected I/O errors.
- `refuses_a_readable_command_that_cannot_be_executed` gives the executable no
  execute permission. Source hashing succeeds but process creation refuses with
  `could not start extension process`, without exposing its contents.

## Signal exit code parity

- Red — `cargo test -p sevro --test run_extension reports_an_extension_signal_exit_using_the_baseline_exit_code -- --exact`:
  an extension terminating itself with SIGTERM reported exit code `-1`, whereas
  the independent Bun CLI probe reported `143`.
- Green — the identical command passed after deriving the conventional Unix
  exit value from the actual termination signal. The CLI still returns protocol
  failure 70 with no retained run evidence.

## Retained cancellation boundary

The pre-spawn cancellation check remains necessary: a signal may arrive after
the previous exchange or while discovery inputs are being prepared. No public
acknowledgement exposes the exact instant the shared cancellation token becomes
set, so forcing that internal branch would require a timing race or private test
seam. It remains validated by inspection and the existing public cancellation
test, without a coverage exclusion. The real deadline test still checks timeout
through process exit, and overflow cleanup now covers a secondary writer error.

## Remaining checks

This boundary does not establish complete preparation or extension grading
parity. Those require successive public CLI regression slices. Additional
preparation and transport controls remain queued.
The coordinator's exact candidate CI remains pending.

At the first transport/source snapshot, `cargo test -p sevro --test run_extension
--locked` passed all four tests, `cargo clippy --workspace --all-targets --locked
-- -D warnings` passed, owned Rust files were formatted, and `bun run check:docs`
passed. This is a diagnostic snapshot, not completion of the extension port.

At the bounded transport/cancellation snapshot, `cargo test -p sevro --test
run_extension --locked` passed all nine tests, including the real 30-second
deadline. `cargo clippy --workspace --all-targets --locked -- -D warnings` and
`bun run check:docs` passed; all owned Rust files were formatted. Compiler
coverage and exact-candidate CI remain the coordinator's separate gates.

At the validation/capability snapshot, `cargo test -p sevro --test run_extension
--locked` passed all 17 tests in 30.31 seconds. Strict workspace Clippy and
`bun run check:docs` passed; owned Rust files and this ledger were formatted.
A concurrent fixture-materialization API transition briefly prevented the first
full-suite compile; its owner completed the integration before this successful
run. That compile failure is not behavioral red evidence.

At the source/transport checkpoint, all 20 extension tests passed in 30.06
seconds. The two existing source-selection regression commands passed both
before and after the invariant refactoring. Strict workspace Clippy, owned-file
Rust formatting checks and documentation checks passed. Coverage thresholds
remain unchanged; the coordinator owns the next frozen-candidate measurement.

## Declared source removed during discovery

The independent TypeScript public CLI probe
`/Users/bjro/.codex/artifacts/sevro-rust-artifact-boundaries-20261016/checkpoint6-extension-source-removed`
uses a real Node extension that synchronously removes its own declared source
after loading, then emits a valid correlated `describe` response. The CLI exits
70 with `declared extension source is unreadable`, no evidence path and no
cases. This checks unreadable source closure after discovery, separately from
the existing changed-content and initially unreadable-source controls. It does
not depend on a competing timer or an injected I/O error.

Initial green — `cargo test -p sevro --test run_extension refuses_a_declared_source_that_becomes_unreadable_after_discovery -- --exact`:
passed on the unchanged product. The exact public failure document, single
discovery exchange, absent deleted source, unchanged synthetic credential and
no-host assertions all passed. No product repair or missing-behavior red is
claimed.

## Source closure checkpoint

After the source-removal control and the paired artifact authorization cases,
`cargo test -p sevro --test run_extension --locked` passed all 21 tests and
`cargo test -p sevro --test run_repository artifacts:: --locked` passed all 12
artifact tests. Strict workspace Clippy, scoped Rust formatting checks and
documentation checks passed. The [artifact ledger](rust-tdd-preparation-artifacts.md#source-authorization-checkpoint)
records the transient unrelated options-test lint and successful rerun.

The cohort is held. All three additions are initial-green characterizations;
extension implementation and transport code remain unchanged.
