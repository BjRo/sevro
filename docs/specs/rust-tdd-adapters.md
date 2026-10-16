# Rust adapter execution TDD

This ledger records the Rust port of the existing TypeScript host-adapter
contract through the public `sevro run` command. The behavior inventory remains
in [CLI and engine parity](rust-cli-engine-parity.md) and
[runtime and host parity](rust-runtime-hosts-parity.md).

## Shared acceptance harness

`tests/fixtures/rust-adapter-scenario.ts` owns the public invocation and retained
evidence assertions. `tests/rust-adapter-cli.test.ts` builds the current candidate
with Cargo before running that scenario. It has no environment override for the
binary path. This build occurs inside the instrumented candidate when the existing
TypeScript coverage gate runs, so Rust embeds the instrumented bridge source.

`crates/sevro/tests/run_adapter.rs` runs the same scenario using Cargo's explicit
`CARGO_BIN_EXE_sevro` binary path as an argument. It does not start another Cargo
build. Rust coverage therefore observes the instrumented Rust binary while the
Bun suite measures the production bridge through the same public behavior.

The bridge is production TypeScript at `src/compat/host-adapter-bridge.ts` and is
included in the source inventory, lint, type checks, and coverage denominator.
Rust owns preparation, evaluation identity, trial execution, assessment, evidence
persistence, and cleanup. The bridge only loads and invokes the existing adapter
module and transports the result. One bridge process belongs to the invocation;
the initial sequential slice uses a serialized transport. Graceful shutdown is
awaited before the Rust command exits.

## Slice 1: retained prompt-only result

The scenario invokes the existing synthetic TypeScript adapter against an inline
fixture, without grading checks, and supplies explicit runner and project digests.
It asserts successful execution, `not_requested` grading, `not_assessed` task,
the declared host route, actual retained `ready` bytes and SHA-256, unknown usage,
and matching public result and latest-result records. Both the CLI result and
retained run evidence must satisfy their published schemas.

Literal focused command:

```sh
cargo test --offline --locked -p sevro --test run_adapter executes_existing_typescript_adapter -- --exact
```

Red: exit 101, with the real CLI returning 64 instead of 0 and reporting
`unsupported option in the Rust dry-run slice: --adapter-module`. The harness
compiled and invoked the binary successfully before the failed behavioral
assertion. No adapter production implementation existed at this red.

Green: the same literal command passed (1 test, exit 0) after integration with
the shared Rust run lifecycle. The fresh-candidate Bun route also passed:

```sh
bun test tests/rust-adapter-cli.test.ts
```

Harness correction: the first scenario misspelled the later explicit digest flag
as `--runner-digest`. The original behavioral red occurred earlier, at the
unsupported `--adapter-module`. The first integrated run exposed the incorrect
digest flag; it was corrected to the existing `--runner-build-digest` before the
successful run. The public result and evidence assertions were unchanged. This
correction is recorded separately from implementation evidence.
The initial red therefore is not a pristine fixture-valid red trace; a later
baseline replay, if performed, must be labeled retrospective.

Owned TypeScript lint, full TypeScript type checking, formatting, and documentation
checks passed. The Rust modules were formatted with the pinned toolchain.
Strict all-target Clippy also passed with warnings denied.

The instrumented diagnostic command was exercised:

```sh
bun run check:typescript --coverage tests/rust-adapter-cli.test.ts
```

Its public scenario passed, and all three registered processes completed with
valid capture evidence, including the embedded production bridge. The command
exited 1 solely because this focused run does not cover the complete production
denominator (191/7723 statements and 41/5781 branches). This is diagnostic
integration evidence, not full TypeScript acceptance. The unchanged 95% gates
remain in force.

## Slice 2: reject a forged final message

An actual TypeScript baseline run returned exit 2, `failed` execution,
`not_requested` grading, `not_assessed` task, and a `sevro.host.failed` diagnostic
when an adapter returned an object as `finalMessage`. That object defined
`toJSON()` returning a string. The TypeScript runner rejected the object before
retaining candidate output. The initial Rust bridge instead serialized it into a
valid-looking string and retained forged output with successful execution.

The shared public scenario asserts the existing failure classification, retained
schema-valid run evidence, unavailable final-message observation, null raw path
and hash, and absence of a raw-output file. It runs through both harness routes.

```sh
cargo test --offline --locked -p sevro --test run_adapter rejects_forged_final_message -- --exact
```

Red: exit 101 because the actual CLI returned 0 instead of the expected 2.
The fixture used the correct existing flags before this red. Production changes
began only after that failure. The bridge now validates the actual final-message
value before JSON serialization; Rust retains the failed host trial.

Green: the same literal command passed (1 test, exit 0), observed by the runtime
owner after integrating failed-trial persistence. Failed workspaces are retained,
and the diagnostic matches the TypeScript baseline's generic host-failure text.

## Slice 3: preserve original final-message bytes

An actual TypeScript baseline retained the original 29 UTF-8 bytes of a final
message containing NUL, Greek text, an emoji, and CRLF even though the result
object defined `toJSON()` returning a different message. The public scenario
asserts those retained bytes, their SHA-256, and the final-message observation's
byte length. This exercises actual output storage rather than a private bridge
protocol assertion.

```sh
cargo test --offline --locked -p sevro --test run_adapter retains_original_utf8_message -- --exact
```

The first attempt encountered an unrelated fixture-integration compilation
failure; a later invocation had an incorrectly supplied local toolchain path.
Neither is behavioral red evidence. After compilation and toolchain prerequisites
were restored, the unchanged focused command failed with exit 101: actual raw
bytes were the nine-byte string `rewritten` instead of the 29 original bytes.
Only then was the bridge changed to copy receipt properties into a transport
object whose `toJSON` is disabled. The same command subsequently passed (1 test,
exit 0). The Rust storage implementation required no change for this slice.

## Slice 4: reject non-finite configuration before serialization

An actual TypeScript baseline rejected nested `Number.NaN` in adapter
configuration with exit 64 and `sevro.invocation.invalid`. JSON serialization
had silently changed this value to `null` in the Rust bridge, admitting an
invocation with different identity inputs.

```sh
cargo test --offline --locked -p sevro --test run_adapter rejects_nonfinite_adapter_configuration -- --exact
```

Red: exit 101 because the real CLI returned 0 instead of 64. The scenario also
requires no adapter-execution marker, no latest result, and a public not-run
invocation failure with no retained run. After the observed red, the bridge
started checking finite numbers recursively before configuration serialization.
The same literal command passed (1 test, exit 0). Rust's identity implementation
was unchanged.

## Slice 5: reject omitted configuration values

The TypeScript canonical identity writer rejects `undefined` property values.
An actual baseline CLI invocation confirmed exit 64 with invalid identity inputs.
The bridge's JSON serialization previously omitted the property and ran the
adapter using different configuration data.

```sh
cargo test --offline --locked -p sevro --test run_adapter rejects_undefined_adapter_configuration -- --exact
```

After unrelated native and extension integration compile errors were resolved,
the command produced a genuine behavioral red: exit 101, actual CLI 0 instead of 64. Only then was configuration validation extended to reject non-JSON values
while continuing to allow absent optional configuration. The same command passed
(1 test, exit 0). The scenario verifies no adapter execution or latest result.

## Slice 6: reject accessor configuration

The existing canonical identity writer inspects property descriptors and rejects
accessors rather than using their returned values. The adapter bridge previously
read the getter and accepted its string result.

```sh
cargo test --offline --locked -p sevro --test run_adapter rejects_accessor_adapter_configuration -- --exact
```

Red: exit 101, with real CLI success 0 instead of invocation failure 64. The
bridge was then changed to inspect property descriptors during recursive
configuration validation. A concurrent provenance signature change temporarily
blocked the next compilation; that failure is not behavioral evidence.

Green: after shared compilation was restored, the same literal command passed
(1 test, exit 0).

## Characterization: valid configuration snapshots

```sh
cargo test --offline --locked -p sevro --test run_adapter snapshots_original_adapter_configuration -- --exact
```

This scenario passed initially. It asserts retained nested JSON configuration
before the host mutates its original object during execution. It also includes a
non-enumerable serializer: Bun 1.3.13's observed serialization ignored that method,
so the predicted rewriting failure did not occur. No implementation change or
red claim was made. The test remains useful public compatibility coverage.

## Slice 7: reject symbol-keyed configuration

An actual TypeScript baseline rejected configuration containing a symbol key with
exit 64 and invalid evaluation identity inputs. The bridge's JSON serialization
had omitted that key and admitted the invocation.

```sh
cargo test --offline --locked -p sevro --test run_adapter rejects_symbol_adapter_configuration -- --exact
```

Shared compilation first needed native and fixture integration fixes. After those
prerequisites, the command failed behaviorally with exit 101: CLI 0 instead of 64.
The bridge then gained symbol-key rejection, and the same command passed
(1 test, exit 0). No native identity or lifecycle changes were needed.

## Slice 8: retain a failed adapter receipt and usage

An actual TypeScript baseline accepts a valid receipt with `executionFailed: true`,
a bounded failure message, partial final output, and complete usage. It returns
exit 2 while retaining the partial raw bytes, their hash, and supplied usage.

```sh
cargo test --offline --locked -p sevro --test run_adapter retains_failed_adapter_receipt_and_usage -- --exact
```

Red: exit 101 because the real public result replaced the adapter's specific
failure message with the generic host-failure text. The scenario additionally
requires partial completeness, exact raw output and SHA-256, and usage values
12 input tokens, 3 output tokens, cost 0.25, and completeness true. The shared Rust
receipt had not admitted these adapter failure fields yet.

Green: the runtime owner observed the same literal command pass (1 test, exit 0)
after admitting the adapter failure fields and carrying the specific diagnostic
alongside the retained partial output and usage. No bridge edit was needed.

Checkpoint regression: `cargo test --offline --locked -p sevro --test run_adapter`
and `bun test tests/rust-adapter-cli.test.ts` each passed all nine shared scenarios
after the current provenance integration compiled. Owned lint, full TypeScript
type checking, formatting, and documentation checks also passed.

## Slice 9: cooperative adapter cancellation

Before changing the candidate, unchanged TypeScript CLI runs established SIGINT
exit 130 and SIGTERM exit 143. Both supplied an actual `AbortSignal`, invoked the
adapter's abort callback once with the exact signal name as its reason, and
retained partial output, SHA-256, and complete usage. The adapter terminated and
awaited its own descendant; that child exited 0 and its PID disappeared. The
cancelled workspace remained. This establishes cooperative adapter cleanup, not
cleanup of arbitrary unmanaged adapter descendants.

The same oracle passed against an earlier instrumented snapshot whose legacy
CLI sources still matched the candidate. Its capture ledger accepted one
registered and completed participant per signal and no forced termination. The
oracle artifacts are outside the worktree under
`/Users/bjro/.codex/artifacts/sevro-rust-adapter-cancellation-20261016/`.

```sh
cargo test --offline --locked -p sevro --test run_adapter cancels_adapter_and_retains_partial_receipt -- --exact
```

Red: compilation succeeded, then exit 101 reported that the real adapter's
`run` callback received no actual `AbortSignal` (`false` instead of `true`). The
fixture completed cleanly on that missing-signal path.

Only after that red, the bridge gained a real `AbortController` and an abort
control message that can arrive while the host call awaits. Rust watches the
existing invocation cancellation token, sends the reason through the same
private connection, and joins that watcher after receiving the actual result.
The runtime owner connected the shared token and cancelled result aggregation.
No second operating-system signal handler or forced child termination was added.

Green: the same literal command passed (1 test, exit 0), including cancellation
status and diagnostic, partial raw bytes and hash, usage, callback reason/count,
awaited descendant cleanup, and retained workspace.

```sh
cargo test --offline --locked -p sevro --test run_adapter terminates_adapter_and_retains_partial_receipt -- --exact
```

The SIGTERM follow-up passed initially with exit 143 and reason `SIGTERM`. It is
compatibility characterization of the implemented signal mapping, not another
red/green claim. All eleven shared scenarios then passed through Cargo and the
fresh-build Bun suite. Owned ESLint, full TypeScript typing, and formatting passed.

`bun run check:typescript --coverage tests/rust-adapter-cli.test.ts` rebuilt the
instrumented candidate and passed all eleven scenarios. Capture integrity
accepted 13 participants and zero forced children, including graceful bridge
completion for both signals. The focused diagnostic still exited 1 because its
sparse coverage over the complete repository denominator was below 95%; it is
not full-suite acceptance evidence. Its retained snapshot is
`/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-typescript-quality-jeBFUx`.

## Slice 10: preserve binary adapter artifacts

An unchanged TypeScript CLI oracle accepted a `Uint8Array` subarray and retained
exactly `[0, 255, 128, 10, 13, 42]`, excluding the surrounding backing-buffer
bytes. Its artifact ID and SHA-256 were retained. The baseline artifacts live
outside the worktree under
`/Users/bjro/.codex/artifacts/sevro-rust-adapter-artifact-20261016/`.

```sh
cargo test --offline --locked -p sevro --test run_adapter retains_adapter_binary_artifact_bytes -- --exact
```

Red: exit 101, with actual CLI 2 instead of 0 because adapter artifacts had not
been admitted by the Rust receipt boundary. The bridge then gained a byte-preserving
base64 representation of actual `Uint8Array` values, and the adapter decoder
translated that representation into the existing neutral Rust artifact type.
The shared runtime's retention and validation remained unchanged.

Green: the same literal command passed (1 test, exit 0), asserting the original
subarray bytes, artifact ID, and SHA-256.

Public compatibility scenarios initially passed for rejecting ordinary arrays
as bytes, unsafe IDs, duplicate IDs, more than 32 artifacts, an artifact exceeding
8 MiB, and aggregate artifacts exceeding 32 MiB. The TypeScript baseline had
independently rejected each with exit 2 and the generic host-failure diagnostic.

Adding a serializer-forged artifact ID exposed a separate real loss: the baseline
rejected the original object, but the bridge serialized it into an accepted ID.

```sh
cargo test --offline --locked -p sevro --test run_adapter rejects_invalid_adapter_artifacts_and_exceeded_limits -- --exact
```

After a tool-path prerequisite was corrected, this command failed behaviorally
with actual CLI 0 instead of 2. Only then was original string-ID validation added.
The same literal command passed (1 test, exit 0). A subsequent green refactor
checks count and byte limits before base64 expansion, while the shared core still
validates decoded bytes and artifact IDs. Rejection leaves no artifact files or
references and preserves the generic, private validator diagnostic.

Both the unchanged baseline and candidate accepted four 8 MiB artifacts alongside
an 8 MiB final message and complete usage. The public maximum-size scenario checks
all four retained artifact lengths, IDs, hashes, and the raw message hash. The
transport has no smaller frame-size ceiling that would truncate valid aggregate
base64 or JSON expansion. This initially green scenario is characterization, not
another red/green claim.

The complete fourteen-scenario Cargo suite passed after the refactor. Owned
ESLint, full TypeScript typing, formatting, and strict workspace Clippy passed.

## Characterization: malformed adapter metadata

The unchanged TypeScript CLI rejects malformed instrumentation IDs and host
capability IDs with exit 64, no host execution, and no evidence or latest result.
Two focused public Rust scenarios passed initially with the same failure
classification. They cover invalid declarations only; they do not establish that
valid advertised capabilities or instrumentation should be refused. The current
unsupported-feature guard remains a separate parity gap.

## Slice 11: observe an exited bridge before connection

The actual baseline used a Bun wrapper that starts real Bun, emits a diagnostic,
and exits 23 before loading the supplied entrypoint. The installed TypeScript
CLI therefore exits 23 without JSON: its interpreter never loaded the CLI.
Missing Bun similarly produces shell exit 127 without JSON. The native CLI's
optional adapter-runtime failures instead belong to its existing host-preparation
failure category: exit 64 with a bounded invocation diagnostic and no run.
These categories are deliberately recorded separately, not claimed as identical
legacy JSON behavior. Baseline outputs are outside the worktree under
`/Users/bjro/.codex/artifacts/sevro-rust-adapter-startup-20261016/`.

```sh
cargo test --offline --locked -p sevro --test run_adapter reports_bridge_exit_before_connection -- --exact
```

Red: compilation succeeded, but the public CLI kept waiting after the real Bun
wrapper had exited. The five-second test watchdog terminated the stuck CLI, and
the assertion failed with `timedOut: true` instead of `false`. The watchdog is
test containment, not expected product behavior; the fixture also removed its
own leftover private bridge directory after observing that failure.

The listener was then made nonblocking while waiting for connection, with child
exit inspection between attempts. An exited child now produces its actual status
in the preparation diagnostic. Failed launch cleanup reaps the child and removes
the private directory.

Green: the same literal command passed (1 test, exit 0). The watchdog did not
fire. The scenario verifies exit 64, the original wrapper diagnostic and status
23, no run/latest result, no remaining child PID, and no private bridge directory.
This slice does not yet establish a timeout for a still-running interpreter that
never connects. The separate unavailable-Bun scenario passed initially.

## Slice 12: preserve runner-owned exit classification

An adapter that sets `process.exitCode = 23` and returns a valid completed receipt
still produces exit 0 in the unchanged TypeScript CLI. The CLI owns the final
result classification rather than preserving the adapter's ambient process value.

```sh
cargo test --offline --locked -p sevro --test run_adapter preserves_result_exit_after_adapter_sets_process_exit_code -- --exact
```

Red: the Rust CLI returned 70 instead of 0 after already retaining the successful
trial; normal bridge shutdown inherited the adapter's exit code 23. The bridge
then explicitly set its normal shutdown status to zero, leaving the actual run
result classification to Rust. Abnormal child termination checks remain intact.

Green: the same literal command passed (1 test, exit 0), including coherent
public result, run evidence, latest result, and retained raw bytes. All nineteen
Cargo scenarios passed. Owned ESLint, full TypeScript typing, and strict workspace
Clippy passed.

The fresh instrumented candidate also passed all nineteen scenarios with
`bun run check:typescript --coverage tests/rust-adapter-cli.test.ts`. Capture
integrity accepted 25 participants and zero forced children; neither successful
startup-failure handling nor ordinary shutdown needed a killed-participant
exception. The focused command exited 1 only for sparse coverage over the complete
repository denominator (260/7793 statements and 87/5829 branches), not a test or
capture failure. Its snapshot is
`/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-typescript-quality-rD5iGM`.

## Slice 13: SIGINT during pending adapter import

The unchanged TypeScript CLI awaits adapter import before installing its runner
signal handlers. A real adapter with a pending top-level await and no signal
listeners exits promptly on SIGINT with status 130, empty stdout, and no run or
latest evidence. The causal import-ready marker and bounded baseline observations
are retained outside the worktree under
`/Users/bjro/.codex/artifacts/sevro-rust-adapter-import-cancellation-20261016/`.
This does not establish a deadline for ordinary imports or a termination
guarantee for modules that install their own signal handlers.

```sh
cargo test --offline --locked -p sevro --test run_adapter interrupts_pending_adapter_import_without_run_evidence -- --exact
```

Red: after correcting a tool-path prerequisite, this command compiled and failed
with `timedOut: true` instead of `false`. The Rust CLI had registered cancellation
before importing the adapter, but its blocking bridge load did not consume that
signal. The test sent SIGINT only after the adapter's import-ready marker, waited
five seconds, and used its watchdog to remove the stuck processes. That watchdog
is test containment, not desired product behavior or a new startup deadline.

The existing invocation cancellation token now reaches adapter loading. A
phase-specific bridge control delivers the signal to existing module listeners;
when none are installed, it exits through `process.exit(130)` so actual exit hooks
can finish. Rust waits for the child and removes its private directory before
returning 130 without publishing invocation JSON. Post-admission AbortSignal,
extension, setup, and native cancellation paths retain their existing semantics.

An intermediate repair still failed the same test: Bun's `process.emit("SIGINT")`
returned true even with zero listeners. A direct runtime observation established
that behavior; the bridge now checks the actual listener count before emitting.
Green: the same literal public command then passed, including no watchdog,
empty stdout, no host callback, no results directory, no remaining bridge PID,
and no private bridge directory.

All twenty adapter Cargo scenarios passed, as did the existing extension and
native invocation-signal regressions, owned ESLint, and full TypeScript typing.
The focused instrumented command was:

```sh
bun run check:typescript --coverage tests/rust-adapter-cli.test.ts -t '^Rust CLI interrupts pending adapter import without run evidence and reaps its bridge$'
```

Its fresh candidate passed the public scenario and capture integrity with three
participants and zero forced children. The bridge produced an actual completed
report; no participant exemption or fabricated forced-child completion was
introduced. The command exited 1 only for sparse coverage over the full repository
denominator: 190/7799 statements and 41/5833 branches. Its snapshot is
`/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-typescript-quality-YoL5rQ`.

## Characterization: SIGTERM during pending adapter import

The separately captured unchanged TypeScript baseline exits 143 on SIGTERM during
pending adapter import, with empty output and no admitted run. The shared public
scenario now sends actual SIGTERM after the same causal import-ready marker and
requires that status, no callback or results directory, and complete owned child
and private-directory cleanup.

```sh
cargo test --offline --locked -p sevro --test run_adapter terminates_pending_adapter_import_without_run_evidence -- --exact
```

This command passed on its first run (1 test). It is an initial-green
characterization, not another red/green claim; no production code or shared
runtime hook changed. All twenty-one adapter scenarios passed, including active
host cancellation and both pending-import signals. Owned ESLint, full TypeScript
typing, and formatting passed.

```sh
bun run check:typescript --coverage tests/rust-adapter-cli.test.ts -t '^Rust CLI terminates pending adapter import on SIGTERM without run evidence$'
```

The fresh instrumented candidate passed this scenario and capture integrity with
three completed participants and zero forced children. Its snapshot is
`/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-typescript-quality-qMg0GB`.
The command exited 1 only because this focused run covered 190/7799 statements
and 41/5833 branches against the unchanged full repository denominator. The
watchdog did not fire, and no new product deadline or signal-handler guarantee
was introduced.

## Slice 14: refuse noncallable adapters before admission

The original public CLI adapter-validation matrix requires string `id`, `model`,
and `effort` fields and a callable `run`. A noncallable `run` produces exit 64
before candidate execution or run storage. The independent baseline observation
is retained under
`/Users/bjro/.codex/artifacts/sevro-rust-adapter-gap-oracles-20261016/metadata-run-not-callable/`.

```sh
cargo test --offline --locked -p sevro --test run_adapter refuses_noncallable_adapter_run_before_admission -- --exact
```

Red: the command compiled and failed with actual CLI exit 2 instead of 64. The
candidate had admitted a trial and reported a host execution failure. The bridge
then gained a load-time callable check before publishing adapter metadata. No
core lifecycle or retained-result policy changed.

Green: the identical literal command passed (1 test). The public scenario asserts
exit 64, `sevro.invocation.invalid`, `not_run`, no cases or evidence path, no host
callback, and no results directory.

The existing invalid metadata cases were then added one at a time:

```sh
cargo test --offline --locked -p sevro --test run_adapter refuses_numeric_adapter_id_before_admission -- --exact
cargo test --offline --locked -p sevro --test run_adapter refuses_null_adapter_model_before_admission -- --exact
cargo test --offline --locked -p sevro --test run_adapter refuses_boolean_adapter_effort_before_admission -- --exact
```

Each passed initially with the same pre-admission assertions. These are
characterizations of existing metadata decoding, not additional red/green claims.
The four unchanged TypeScript public CLI baseline cases also passed together:

```sh
bun test tests/cli/case-validation.test.ts -t '^CLI refuses malformed adapter (id|model|effort|run) at its public module boundary$'
```

All twenty-five Cargo adapter scenarios passed, including signal, retained-byte,
artifact-boundary, and shutdown regressions. Owned ESLint, full TypeScript
typing, formatting, and strict workspace Clippy passed. The instrumented public
cohort ran with:

```sh
bun run check:typescript --coverage tests/rust-adapter-cli.test.ts -t '^Rust CLI refuses a (noncallable adapter run|numeric adapter id|null adapter model|boolean adapter effort) before admission and storage$'
```

Its fresh candidate passed all four scenarios and capture integrity with six
completed participants and zero forced children. The snapshot is
`/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-typescript-quality-RmKXh8`.
The command exited 1 only for sparse coverage against the complete repository
denominator: 202/7801 statements and 45/5835 branches. This focused run is not
full TypeScript coverage acceptance.

## Slice 15: preserve invalid condition evidence classification

The shared public scenario first passed against the unchanged TypeScript CLI.
Its adapter returns an object as `actualCondition`, a final message, and complete
numeric usage. The established outcome is exit 2 with
`sevro.instrumentation.mismatch` and `host condition evidence is invalid`, a
retained failed fixture, and null raw output and usage from the unaccepted
receipt. The earlier independent object-condition baseline is also retained under
`/Users/bjro/.codex/artifacts/sevro-rust-adapter-gap-oracles-20261016/receipt-condition-object/`.

```sh
cargo test --offline --locked -p sevro --test run_adapter rejects_invalid_adapter_condition_evidence -- --exact
```

Red: this command compiled and failed on the exact diagnostic comparison. Rust
returned `sevro.host.failed` / `host execution did not complete`, while the
baseline requires the instrumentation classification above. Production was
unchanged when that failure was observed.

The receipt decoder now classifies invalid wire condition evidence before
deserializing the receipt. `HostError` carries that domain variant directly
through adapter execution and `HostContext::execute`; native string failures are
adapted at the existing host boundary. Records explicitly match the typed variant,
normalize ordinary execution errors to the generic private diagnostic, and retain
the established messages from returned failed receipts. Cancellation still takes
precedence. `RunError` remains responsible for other lifecycle and storage errors.

Green: the identical literal command passed (1 test). It asserts the exact
diagnostic in CLI and run evidence, failed execution, coherent result/latest,
unavailable observation, unknown actual condition, null raw path/hash and usage,
no raw file, retained fixture contents, and no private condition payload in stderr.

All twenty-six adapter scenarios and the receipts, results, console, and required
evidence suites passed: forty-two tests in total. Four additional focused native
regressions passed for private preflight failure, invalid/incomplete transcripts,
timeout, and invocation cancellation. The fresh-build Bun public scenario also
passed, alongside owned ESLint, full TypeScript typing, scoped formatting,
strict workspace Clippy, and documentation checks. The JavaScript bridge and its
wire protocol did not change in this slice.

## Slice 16: preserve completed evidence when an adapter exit hook fails

The unchanged TypeScript public CLI oracle is retained under
`/Users/bjro/.codex/artifacts/sevro-rust-adapter-gap-oracles-20261016/exit-hook-failure/`.
An adapter registers `process.on("exit", () => { process.exitCode = 23; })`
and returns `ready`. The process exits 23 after publishing completed JSON,
run evidence, result, and latest records whose evaluation exit code remains 0.
The baseline completed without its watchdog. This differs from setting
`process.exitCode` during the host call, which the CLI resets to the run outcome.

Red — `cargo test --offline --locked -p sevro --test run_adapter preserves_completed_result_when_adapter_exit_hook_fails -- --exact`:
the unchanged Rust product compiled and returned 70 instead of 23, reporting
`adapter bridge exited with exit status: 23`.

The transport now returns the actual child exit code after an acknowledged
shutdown separately from transport errors. The typed outcome passes through
the adapter session and host context. The CLI keeps the completed result and
uses that child code only when the run itself succeeded. Existing nonzero run
outcomes retain precedence; unacknowledged shutdown and signal termination
retain their existing error classification. Records and the JavaScript bridge
were unchanged.

Green — `cargo test --offline --locked -p sevro --test run_adapter preserves_completed_result_when_adapter_exit_hook_fails -- --exact`:
1 test passed. The shared public scenario verifies process exit 23, completed
JSON and retained records with exit code 0, exact `ready` bytes and SHA-256,
the reaped bridge process, removal of its private directory, and cleanup of the
successful fixture.

All twenty-seven adapter scenarios and four console tests passed, along with
owned ESLint and full TypeScript typing. The first combined regression command
also encountered the runtime owner's concurrently added, intentionally red
artifact/check-ID collision test; that failure is not exit-hook regression
evidence. The runtime owner subsequently reported its identical focused command
green.

The actual instrumented Bun scenario ran with:

```sh
bun run check:typescript --coverage tests/rust-adapter-cli.test.ts -t '^Rust CLI preserves completed evidence when an adapter exit hook fails$'
```

The shell tool returned its 120-second timeout before collecting command output.
The owned process tree then finished naturally, without a kill or rerun. Retained
artifacts at
`/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-typescript-quality-cHnJMP`
establish one passing test against its fresh candidate and a successful capture
integrity merge: three completed participants, including the bridge, and zero
forced children. `capture-run.json` and `coverage-enforcement.json` preserve the
candidate-bound report and full denominator. Targeted coverage is 212/7801
statements and 52/5835 branches, below the unchanged 95% thresholds. The test and
capture evidence are complete; the top-level command exit was not observed,
and this focused run is not full TypeScript acceptance.

## Slice 17: reject nonplain adapter configuration before admission

The review's identity-contract blocker concerns configuration values coerced by
bridge serialization. [Identity v1](../identity-v1.md), parity requirement I04,
and `CanonicalJsonWriter.assertPlainObject` in `src/identity.ts` require ordinary
or null-prototype JSON objects. The embedded bridge remains self-contained.

Actual TypeScript public CLI evidence is retained under
`/Users/bjro/.codex/artifacts/sevro-adapter-configuration-review-20261016/`.
The `date` invocation supplies a nested `Date`. It exits 64 with
`sevro.invocation.invalid` / `invalid evaluation identity inputs`, not-run
execution, empty cases, null evidence, no host invocation and no results directory.
Each oracle directory retains the exact argv, adapter, case, stdout, stderr and
summary. No native host is involved.

Red — `cargo test --offline --locked -p sevro --test run_adapter rejects_date_adapter_configuration -- --exact`:
the unchanged bridge admitted the Date and completed the real adapter with exit 0
instead of 64.

The bridge now refuses non-array objects whose prototype is neither
`Object.prototype` nor `null`. It retains the existing symbol/accessor/value
validation and rejects before returning host metadata to Rust.

Green — `cargo test --offline --locked -p sevro --test run_adapter rejects_date_adapter_configuration -- --exact`:
1 test passed. The public scenario verifies refusal, absent host invocation and
absent results allocation.

The independent `map` oracle has the same refusal and absence assertions.
Initial green — `cargo test --offline --locked -p sevro --test run_adapter rejects_map_adapter_configuration -- --exact`:
1 test passed with the prototype repair already present; this is a characterization,
not a second claimed red. No additional product edit was made for Map.

The independently captured `custom-class` oracle likewise refuses a nested class
instance with an ordinary enumerable `value` field.
Initial green — `cargo test --offline --locked -p sevro --test run_adapter rejects_class_adapter_configuration -- --exact`:
1 test passed without a further product change. These three scenarios have matching
wrappers in the existing Bun acceptance suite so the embedded bridge remains
measured by the TypeScript gate.

The actual `null-prototype` TypeScript run succeeds with nested null-prototype
objects containing strings, booleans, finite numbers, null and an array. With
jobs 3, its literal retained configuration digest is
`8d9f7597ee8ba15fce32a20b9e36b411033e15e0180558f85b3fb81302ed8d99`.
Initial green — `cargo test --offline --locked -p sevro --test run_adapter preserves_null_prototype_adapter_configuration_identity -- --exact`:
1 test passed, retaining the expected JSON values and the same digest. This
accepted-input control required no product change.

## Slice 18: snapshot configuration without invoking serialization hooks

The independent `serializer-getter` TypeScript oracle accepts a plain nested
object with a nonenumerable `toJSON` getter that throws if evaluated. It completes
the adapter, retains `{ "candidate": { "nested": { "value": "kept" } } }`, and
records configuration digest
`36047738ff8fd893dcf989199ccdd3d254c3f6c445448bc5e37d4483be98d21f`.
The canonical writer reads enumerable own data descriptors and ignores the hook.

Red — `cargo test --offline --locked -p sevro --test run_adapter ignores_adapter_configuration_serializer_getters -- --exact`:
the bridge's serialization invoked the getter and returned exit 64 with
`adapter failed: "serializer-called"` instead of completing with exit 0.

Validation now produces a detached JSON snapshot. Arrays recursively copy their
values; plain objects copy enumerable own data descriptors into null-prototype
records. The transport serializes that snapshot, not the adapter's original
objects. Prototype, finite-number, symbol, accessor and non-JSON validation remains
in place. No runtime import was added to the embedded bridge.

Green — `cargo test --offline --locked -p sevro --test run_adapter ignores_adapter_configuration_serializer_getters -- --exact`:
1 test passed. The retained nested value is unchanged. The regression was then
strengthened with the literal independently observed configuration digest.
The existing original-configuration scenario separately retains its established
nonenumerable callable serializer and host-mutation control; its historical
initial-green observation above remains unchanged.

Validation for the closed configuration finding:

- `cargo test --offline --locked -p sevro --test run_adapter -- --test-threads=1`:
  all 32 public adapter scenarios passed, including the strengthened literal
  digest assertion and the existing original-configuration control.
- `bun test tests/rust-adapter-cli.test.ts -t "Date adapter configuration|Map adapter configuration|custom-class adapter configuration|null-prototype configuration|configuration serializer getters"`:
  all five new acceptance wrappers passed against the freshly built candidate.
- `cargo clippy --workspace --all-targets --offline --locked -- -D warnings`:
  passed.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/tests/run_adapter.rs`:
  passed.
- `./node_modules/.bin/eslint src/compat/host-adapter-bridge.ts tests/fixtures/rust-adapter-scenario.ts tests/rust-adapter-cli.test.ts --max-warnings 0`:
  passed.
- `./node_modules/.bin/tsc --noEmit`: passed.
- `./node_modules/.bin/prettier --check src/compat/host-adapter-bridge.ts tests/fixtures/rust-adapter-scenario.ts tests/rust-adapter-cli.test.ts docs/specs/rust-tdd-adapters.md`:
  passed.
- `bun run check:docs`: passed.

These are scoped repair checks. Whole-candidate acceptance, instrumented coverage
and independent repair verification remain the coordinator's checkpoints.

## Remaining parity slices

The first slice does not establish full adapter parity. Required later public
scenarios cover grading, remaining bounded and lossless receipt validation,
callback acknowledgment after diagnostic persistence, instrumentation and host
capabilities, shared state under concurrency, getter timing, metadata mutation,
and cancellation from bridge-local process signals or noncooperative adapters.
Unsupported nonempty instrumentation/capabilities and additional receipt fields
are currently refused instead of silently discarded.

Thrown `HostExecutionFailure` remains a separate compatibility gap. The original
runner recognizes the exact exported class, while the current bridge only retains
returned failure receipts. The packaged bridge and source API need a shared class
module; duck-typing an arbitrary error's `result` would change the contract.
An installed-package oracle now confirms that the facade reexport and its own
`evaluation/types.ts` share one constructor, while a same-name lookalike and the
genuine class from a second package installation both receive the generic
failure treatment. Evidence is retained outside the worktree under
`/Users/bjro/.codex/artifacts/sevro-rust-host-failure-identity-20261016/`.
A future explicit native bundle can bind its own declared, verified class-module
asset and import that exact constructor in the bridge. The standalone preview has
no such external binding; it must not guess a nearby package or source checkout.

Forced termination needs coverage-ledger integration: the existing Bun preload
can attest its direct children, while this bridge is owned by Rust. A force-killed
bridge needs an explicit authorized parent/child checkpoint declaration before a
cancellation scenario can satisfy the existing coverage integrity gate. Ordinary
bridge shutdown completes its capture normally. No denominator or missing-report
exception is introduced by this slice.
