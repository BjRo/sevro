# Rust native host TDD evidence

The first Codex slice executes one passive turn through the public Rust CLI.
It preserves real native sandbox preflight, private authentication and state,
protected input boundaries, bounded process output, and retained event bytes.
This is partial implementation evidence, not completion of the native-host port.

## Independent baseline and seam

The unchanged TypeScript CLI at `1400f3f` supplied the oracle. Its existing
`tests/cli/codex-route.test.ts` scenario passed locally with 11 assertions.
A separate controlled native wrapper then returned the fixed `ready` response
and token counts 12 and 4, while delegating `sandbox` to the installed Codex CLI.
The wrapper also used the generated permission profile to verify actual fixture
read/write access and denied reads of source authentication, copied authentication,
private configuration, and a peer workspace created after launch.

The observed result was exit `0`, execution `completed`, grading `not_requested`,
and task `not_assessed`. Cost remained unknown. The retained response had SHA-256
`b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6`;
the three-line `sevro.codex.events` artifact had SHA-256
`d3e1e18fe8be1491beb8746fa8fcc71d524f89128e7c42c5e6fc58ea94c2363d`.
Successful fixture and native private state were removed, and the source
authentication file remained unchanged. These are literal observed values,
not values recomputed from the Rust implementation.

The durable integration test is
`crates/sevro/tests/run_native_codex.rs::executes_isolated_codex_turn`.
It uses the real CLI binary and native sandbox. Only the external model turn
is synthetic; no authenticated model call is made.

## Slice 1: isolated passive Codex turn

Red — `cargo test -p sevro --test run_native_codex --locked executes_isolated_codex_turn -- --exact`:
the test compiled and failed with expected exit `0`, actual exit `64`, and
`Rust candidate execution is not yet implemented; this slice requires --dry`.
Native product code and option support had not changed before this observation.

Green — `cargo test -p sevro --test run_native_codex --locked executes_isolated_codex_turn -- --exact`:
one test passed after implementing the native route and retaining host artifacts
through the neutral core receipt. The sandbox denial probes, fixed byte hashes,
usage values, state cleanup, and credential privacy assertions all passed.

An intermediate assertion compared Rust JSON number representations `12.0`
and `12` structurally. The test was corrected to compare their semantic numeric
values; the independent expected counts remained 12 and 4. Production was not
changed for that representation difference.

Observed locally on macOS arm64 with Codex CLI `0.163.0`. The Ubuntu implementation
uses the corresponding native empty-root policy and helper paths, but this local
green does not establish Ubuntu acceptance. Both supported GitHub CI environments
must validate the published candidate.

## Remaining boundaries

This slice covers one inline passive candidate without runtime policy, mounts,
continuation, plugins, native controls, or requested skill activation evidence.
Those collectors are not replaced with fabricated unavailable or partial receipts.
Required missing evidence must remain unavailable. Claude, app-server, runtime
configuration, native hooks, transcript access, continuation, further failure
artifacts, and remaining timeout/process controls need further public slices.
The core owns invocation cancellation; native code installs no signal handlers.

The process uses a new owned process group, concurrent bounded pipe drains,
deadline enforcement, and private-state cleanup. Further process-boundary slices
must cover interruption during preflight and remaining failures.

## Slice 2: retain failed preflight evidence

The unchanged TypeScript CLI supplied a preflight that exits `70` with a fixed
private stderr line. It reports exit `2`, keeps the failed fixture inspectable,
does not launch the model turn, and removes native private state. Its retained
`codex.process` identifies `isolation-preflight`, reason `exit`, timeout `60000`,
code `70`, null signal, measured duration, and `stderrTruncated: false`.
`codex.stderr` contains the original bytes, which do not appear in public output.

Red — `cargo test -p sevro --test run_native_codex --locked retains_private_preflight_failure -- --exact`:
the CLI reported exit `2`, but the test failed because the `codex.process`
artifact was missing. Product code still discarded the failed process receipt.

Green — `cargo test -p sevro --test run_native_codex --locked retains_private_preflight_failure -- --exact`:
one test passed after preserving bounded process evidence through the neutral
failed host receipt. The exact metadata, private stderr bytes and permissions,
no-model-launch condition, private-state cleanup, and retained fixture all passed.

## Slice 3: native deadline and descendant cleanup

The unchanged TypeScript CLI supplied the existing `--codex-timeout-ms 200`
example. After real sandbox preflight, the controlled native turn creates a
sleeping child and stalls. The baseline reports exit `2` and
`Codex run timed out after 0.2 s`; its private process receipt records phase
`execution`, reason `timeout`, timeout `200`, code `137`, and signal `SIGKILL`.
The owned child stops and native private state is removed. The stderr prefix
remains a private artifact, while the failed fixture remains inspectable.

Red — `cargo test -p sevro --test run_native_codex --locked times_out_native_turn_and_owned_descendant -- --exact`:
after a concurrent cancellation-module integration compiled, the focused test
failed with expected exit `2`, actual exit `64`, and unknown option
`--codex-timeout-ms`. No timeout product changes preceded that behavioral red.
The earlier temporary missing cancellation-module compile error is not red evidence.

Green — `cargo test -p sevro --test run_native_codex --locked times_out_native_turn_and_owned_descendant -- --exact`:
one test passed after adding the existing bounded timeout option, retaining
termination metadata, and mapping the structured failure to the known diagnostic.
The actual stopped descendant, receipt fields, stderr bytes, private-state cleanup,
and failed-fixture retention all passed.

## Platform selection and boundary characterizations

The first frozen coverage snapshot compiled Linux-only preparation and profile
branches into its macOS executable through runtime `cfg!` checks. The refactor
uses compiler target selection for those platform implementations, as required
by the Rust quality contract. All three existing native tests stayed green.
No production coverage attributes or exclusions were added, and Linux behavior
was not simulated on macOS. Ubuntu still requires its own real CI execution.

Additional unchanged TypeScript CLI observations supplied the credential,
configuration, transcript, and protected-worktree expectations. The public Rust
characterizations were initially green and are not claimed as red/green slices:

- Missing, directory, and oversized authentication files fail before a native
  process launches. Invalid fixture-owned Codex configuration, relative host
  configuration roots, control characters in configuration paths, and executable
  symlinks into the protected project also fail before native launch.
- Malformed events, duplicate or missing lifecycle events, failed turns,
  incomplete streams, and nonzero process exits fail without successful raw or
  transcript artifacts. Native private state is removed and failed fixtures
  remain inspectable.
- Unknown events and blank lines are tolerated; messages after turn completion
  do not become the final response. Missing, fractional, negative, string, or
  unsafe token counts remain unknown without failing an otherwise completed turn.
- A real fixture-only Git repository and linked worktree exercise the repository
  closure. The actual sandbox denies access to the linked worktree's private
  input while preserving candidate fixture read/write access.

The local independent observations are retained as `baseline-boundaries.json`
and `baseline-guards.json` under the preparation artifacts directory. No
TypeScript production code or existing TypeScript test was changed.

## Slice 4: integral JSON usage numbers

The unchanged TypeScript CLI receives counts written as `12.0` and `4.0`, and
reports complete usage with numeric counts 12 and 4. This is a transcript parsing
difference, separate from the first slice's assertion representation correction.

Red — `cargo test -p sevro --test run_native_codex --locked accepts_integer_valued_json_usage -- --exact`:
the test compiled and completed the candidate, but expected input count `12.0`
was absent. Product parsing accepted only the integer JSON representation.

Green — `cargo test -p sevro --test run_native_codex --locked accepts_integer_valued_json_usage -- --exact`:
one test passed after validating the numeric value as a nonnegative safe integer.
Fractional, negative, unsafe, and string values remain unknown in the public
characterizations; the expected counts were not changed.

## Slice 5: invocation signals stop the native process group

The unchanged TypeScript CLI was signalled after a controlled native turn had
started a sleeping descendant, following real sandbox preflight. SIGINT and
SIGTERM produced exit 130 and 143 respectively, execution `cancelled`, and the
public `sevro.run.cancelled` diagnostic with message `run cancelled`. Both private
process receipts recorded phase `execution`, reason `cancelled`, timeout `2000`,
code `137`, and signal `SIGKILL`. The descendant stopped, private native state
was removed, and private stderr and the interrupted fixture remained inspectable.
These observations are retained in `baseline-cancellation.json`.

Red — `cargo test -p sevro --test run_native_codex --locked cancels_native_turn_and_owned_descendant_on_invocation_signal -- --exact`:
the test compiled and the CLI reported cancellation, but its native process
continued to the deadline. The private receipt recorded `timeout` instead of
the independently observed `cancelled` reason.

Green — `cargo test -p sevro --test run_native_codex --locked cancels_native_turn_and_owned_descendant_on_invocation_signal -- --exact`:
one test passed for both signals after passing the invocation's existing
cancellation token into native preflight and execution. The native process
polls that token, terminates its owned group, and retains the actual interrupted
receipt. Native code installs no signal handlers.

The cancellation case intentionally requests one trial. A preliminary two-trial
TypeScript probe produced two evidence records; default concurrent admission
means this is not evidence of an unadmitted trial. Multi-trial scheduling remains
a separate core boundary.

## Further process and filesystem characterizations

The unchanged TypeScript CLI supplied the next initially green controls in
`baseline-process-boundaries.json`, `baseline-held-pipes.json`, and
`baseline-namespaces-macos.json`. These are characterization evidence, not
invented red/green results:

- Non-agent items and malformed item payloads do not replace the final message.
  An agent message without string text yields no final response. Invalid UTF-8
  fails without retaining a successful response or transcript.
- Stdout above 8 MiB fails and the owned descendant stops. Failed preflight
  stderr retains exactly its first 65,536 bytes with `stderrTruncated: true`
  and private file permissions. A missing interpreter produces a bounded host
  launch failure, and preflight exit 71 identifies the executable phase.
- Native parent exit does not end pipe collection. Delayed stdout/stderr from
  an owned descendant is drained. A descendant holding inherited pipes beyond
  the deadline is stopped; the timeout receipt truthfully retains the already
  exited parent's code `0` and null signal, rather than inventing `SIGKILL` for it.
- An absent optional host configuration directory remains optional. On macOS,
  an existing owned private namespace works, while a shared, symlink, or regular
  file namespace fails before native launch. This namespace test uses macOS's
  isolated temporary root; it does not modify Linux's shared `/var/tmp` namespace.

## Slice 6: protect the relocated standalone assessment executable

The installed TypeScript package was copied with its dependencies to a fresh
temporary installation outside the user home. Its real native sandbox denied
reads of the installed CLI, evaluation types, and run-evidence schema. The
independent observation and asset hashes are retained in
`baseline-installed-assets.json`; the original packed-package evidence was not
modified.

For standalone Rust, the assessment assets are embedded in the running executable.
The public test copies that executable beside the native binary, outside the
project and home roots. This exercises a normal shared executable directory:
Codex's executable remains readable, while the assessment executable must not.

Red — `cargo test -p sevro --test run_native_codex --locked process_boundaries::protects_relocated_standalone_executable_beside_native_binary -- --exact`:
the test compiled and the actual sandbox read the moved `binary/sevro` file.
The candidate wrote that exact readable path into its retained failed workspace.

Green — `cargo test -p sevro --test run_native_codex --locked process_boundaries::protects_relocated_standalone_executable_beside_native_binary -- --exact`:
one test passed after protecting the canonical running executable. The runtime
no longer guesses a protected source checkout from `CARGO_MANIFEST_DIR`.
Explicit project, configuration, results, fixture, user, and repository boundaries
remain protected. No parent directory or future bundle root is inferred from the
executable path. Real macOS file denial passed; Ubuntu requires its own CI result.

## Remove duplicate validated invariants

The internal Codex constructor has one caller: core host preparation from the
validated `Candidate::Codex`. CLI and manifest selection require nonempty model
and effort, and canonicalize executable and authentication paths. The constructor
now accepts those already validated values without repeating their checks.
The core owner made host preparation infallible accordingly.

The private profile formatter receives canonical workspace, protected, and read
roots plus children of the canonical private state root. Its duplicate absolute
path check was removed; UTF-8 and control-character validation remain. Native
namespace ownership, permissions, workspace separation, fixture metadata,
authentication bounds, cancellation, and unsupported-feature checks remain.
These are green refactors supported by inspected callers and public regressions,
not substitutes for missing filesystem security tests.

## Path and protected-repository characterizations

The next read-only gap assessment produced independent observations in
`baseline-path-metadata.json`. Three additional public tests were initially
green; no native production change was needed:

- Spaces, Unicode (`café` and `漢`), and apostrophes in project, temporary, and
  deployed executable paths preserve actual sandbox access and denial behavior.
  The moved assessment executable remains unreadable beside the native binary,
  while fixture read/write access and private authentication still work.
- Corrupt `.git` metadata and an unreadable real `.git/config` in a separate
  configuration root fail before native launch. The selected project has no
  repository, so these cases reach protected-root inspection independently of
  project provenance.
- A real registered linked worktree deleted before invocation remains in Git's
  actual porcelain output. Both implementations tolerate its absent path while
  preserving the existing protected repository. No fake Git output or concurrent
  filesystem mutation is involved.

The unchanged TypeScript CLI's real Codex preflight failed for a double-quote
path on the measured macOS installation. That outcome was recorded separately;
the successful path characterization does not claim double-quote support or
Ubuntu acceptance.

The remaining native coverage gaps include serialization-error closures over
known JSON string/value representations, OS process/pipe errors, disconnected
workers, and defensive namespace/ownership checks not reachable through the
current canonical fixture allocation route. These are classified as unobserved
defensive paths, not presented as exercised behavior. No impossible PID/UID,
worker-panic, or race-only test was added, and no security guard or production
coverage region was excluded.

## Slice 7: passive same-thread continuation

The unchanged TypeScript public CLI supplied the independent oracle in
`baseline-continuation.json`, followed by `baseline-continuation-required.json`
with `requiredEvidence: ["sevro.codex.continuation"]`. Both observations returned
exit `0`, task `passed`, final message `follow-up ready`, and complete summed usage
of 17 input and 6 output tokens. The first native turn received `Wait.` and the
resumed turn received `Continue.` through stdin.

The controlled wrapper delegates real sandbox operations to installed Codex and
checks denied source authentication, copied authentication, and private
configuration reads during both turns. The initial process writes a private
session proof before completing. Resume must match its original workspace,
private homes, profile, model, effort, and approval setting. This provides causal
ordering without timed sleeps. The initial invocation omits `--ephemeral`; the
second uses `exec resume` with the original `thread-1` and no new `-C` argument.

The initial process writes a real native-session entry at ordinal `0`; resume
appends ordinal `1`. The retained continuation observation records ordinal `0`,
the boundary before the second prompt, with `preFollowUpWorktreeUnchanged: true`
and completeness `complete`. A bounded workspace fingerprint and bounded,
validated native-session reader produce these values; neither is fixed to the
fixture expectation. The observation retains no session payload or file content.

Red — `cargo test -p sevro --test run_native_codex --locked continuation::resumes_original_thread_and_grades_second_response -- --exact`:
the durable public test compiled and observed exit `2` instead of `0` while the
native continuation refusal remained in place. After adding the required evidence
declaration to this same test, the unchanged TypeScript baseline remained green
and the same Rust command remained behaviorally red before native product changes.

Green — the same literal command passed after implementing two turns in one
private runtime, original-thread validation, second-response grading, summed
usage, and separate retained event streams. The core owner added typed native
observation persistence and complete required-evidence recognition. The CLI owner
enabled only `sevro.host.continuation` for executed Codex hosts.

The test checks the independently observed artifact SHA-256 values:
`f2eb4006bf9c12c9eed26cd8ae14f11becbaaa53face28eb1e0fecd2f04f9df8` for
`sevro.codex.events` and
`742b2933e9e6ac43828aa74e54087787bf2f0f568591ac206260c4fe2bcf9094` for
`sevro.codex.follow-up-events`. It also checks actual invocation order, both
prompts, cleanup, credential privacy, and the exact complete continuation receipt.

This first continuation green was measured on macOS. Ubuntu acceptance remains
unmeasured locally. Passive native collectors, hooks, control policy, app-server,
and Claude remain outside this slice; their observations and capabilities are
not fabricated. Further continuation failure and partial-evidence boundaries
remain for separately observed public slices.

## Failed follow-up characterization

The unchanged TypeScript public CLI oracle in
`baseline-continuation-failure.json` uses the same two-turn fixture and required
continuation evidence. The first turn completes successfully. The resumed
process emits its valid completed event stream, then exits `7`. Both invocations
are verified through the original private session proof and recorded launch
order; no timed synchronization is involved.

The observed CLI exit is `2`, execution is `failed`, grading is `not_requested`,
and task verdict is `not_assessed`, with the generic `sevro.host.failed`
diagnostic. Neither turn's event artifact is retained. The raw result path and
hash are null, usage counts are all unknown with completeness false, and the
continuation observation is absent rather than partial. The failed fixture
remains inspectable, all native private state is removed, and the source
authentication remains unchanged.

Initial green — `cargo test -p sevro --test run_native_codex --locked continuation::rejects_failed_follow_up_after_successful_first_turn -- --exact`:
the test passed on its first executable run with native product code unchanged.
It asserts the actual baseline outcomes, both prompts and invocations, original
thread resume, retained failed fixture, private-state cleanup, and credential
privacy. This is a public characterization, not red/green implementation evidence;
no product repair was made.

## Continuation lifecycle characterizations

Three further public cases use independently captured unchanged TypeScript CLI
oracles under
`/Users/bjro/.codex/artifacts/sevro-rust-native-preparation-20261016`:
`baseline-continuation-wrong-thread.json`,
`baseline-continuation-timeout.json`, and
`baseline-continuation-sigterm.json`. Each completes the first turn and verifies
that the second invocation resumes the original private session with `Continue.`.

The wrong-thread process emits a complete stream naming `foreign-thread` and
exits successfully after being asked to resume `thread-1`. The CLI nevertheless
returns exit `2` and a generic host failure. Both event artifacts, the raw result,
usage, and the continuation observation are absent. Grading is not requested and
the task is not assessed. The failed workspace remains available and native
private state is removed.

The deadline case starts an owned descendant during resume and waits for it.
With a 2000 ms deadline, the CLI returns exit `2` and the specific timeout
diagnostic. The cancellation case sends SIGTERM only after the resumed process
has recorded its real descendant PID; it returns exit `143` with execution
`cancelled`. Both retain only the second process's private `codex.process` and
`codex.stderr` artifacts, with reason `timeout` or `cancelled`, respectively.
The receipt records execution phase, SIGKILL, and code `137`; the stderr artifact
has SHA-256
`05a2f5241e3ef66c65a1663d9eb9c1895af9f046cef1db00df25d7fe59c087dd`.
No event streams, raw result, usage, or continuation observation survive these
failures. Both stop the owned descendant, retain the candidate workspace, remove
private state, and leave source authentication unchanged. The test checks actual
process state and private artifact permissions as well as the public result.

Each literal command passed on its first run with native product code unchanged:

- `cargo test -p sevro --test run_native_codex --locked continuation::rejects_completed_follow_up_from_different_thread -- --exact`
- `cargo test -p sevro --test run_native_codex --locked continuation::times_out_follow_up_and_stops_owned_descendant -- --exact`
- `cargo test -p sevro --test run_native_codex --locked continuation::terminates_follow_up_and_owned_descendant_after_resume_starts -- --exact`

These are initial-green public characterizations, not red/green repair evidence.
They were measured on macOS; Ubuntu acceptance remains unmeasured locally.
Unreadable-workspace, session-evidence validation, and workspace fingerprint
mutations remain separate pending families. No native controls or Claude behavior
was added.

## Continuation evidence characterizations

The next family captures each unchanged TypeScript public CLI oracle before
adding its corresponding Rust test. The external
`observe_continuation_evidence.py` script under the preparation artifact directory
replays one named scenario at a time and preserves the complete result, evidence,
invocations, private-state cleanup, and artifact bytes. Each uses the same explicit
native wrapper, real sandbox checks, and required continuation evidence.

`baseline-continuation-unreadable-workspace.json` records a first turn that creates
a regular workspace file and makes it unreadable before completing. Both turns
complete and the exact second-response check passes. The continuation observation
is partial, with ordinal `0` and a null workspace comparison. Required evidence
therefore makes grading unavailable: CLI exit `4`, task `not_assessed`, and a
retained candidate workspace. Both event artifacts, the second response, and
complete usage of 17 input and 6 output tokens remain available. The test confirms
the retained file has mode `000` and actually cannot be read.

Eight session scenarios independently preserve a complete, unchanged workspace
comparison but produce a null native ordinal. All return exit `0`, completed
grading, and task `passed`, while retaining the same response, usage, and two
private event artifacts. Their baseline filenames are
`baseline-continuation-<scenario>.json`:

- `missing-session` removes the first turn's session file before the boundary.
- `malformed-session` appends a non-JSON tail after a valid entry.
- `nonmonotonic-session` appends another ordinal `0`, violating strict increase.
- `oversized-session` pads an otherwise valid stream with whitespace beyond
  8 MiB, isolating the byte bound from JSON validity.
- `ambiguous-session` creates a second physical filename matching the thread.
- `negative-session-ordinal`, `fractional-session-ordinal`, and
  `unsafe-session-ordinal` each replace the stream with one valid JSON entry whose
  ordinal is `-1`, `0.5`, or `9007199254740992`, respectively.

The durable cases each use the literal command
`cargo test -p sevro --test run_native_codex --locked continuation::evidence::<case> -- --exact`
with the following exact case names, in this order:

1. `marks_unreadable_workspace_continuation_partial`
2. `keeps_continuation_complete_when_session_file_is_missing`
3. `discards_session_ordinal_after_malformed_tail`
4. `discards_session_ordinal_when_ordinals_repeat`
5. `discards_session_ordinal_when_stream_exceeds_byte_limit`
6. `discards_session_ordinal_when_multiple_files_match_thread`
7. `discards_negative_session_ordinal`
8. `discards_fractional_session_ordinal`
9. `discards_session_ordinal_above_safe_integer_limit`

All valid characterizations passed with native product code unchanged. The first
repeated-ordinal attempt contained an unmatched shell quote in the test fixture;
after correcting it to match the independent oracle, the same focused command
passed. That fixture error is not product red evidence. No production repair,
coverage exclusion, race-dependent growth, or simulated OS failure was introduced.
Both invocations, original-thread resume, cleanup, unchanged source authentication,
private artifact modes, and absence of private content from public evidence are
checked. Workspace fingerprint mutations were deferred to the next family below.
These observations were measured on macOS; Ubuntu acceptance remains unmeasured
locally.

## Continuation fingerprint characterizations

Five independently captured unchanged TypeScript public CLI oracles establish the
visible workspace comparison. The external `observe_continuation_fingerprint.py`
script and `baseline-continuation-fingerprint-*.json` reports remain under the
preparation artifact directory. Each mutation completes during the first turn,
before its completion event, so the boundary is causally ordered without sleeps.

The `file-content` case replaces an existing file's bytes. The `directory` case
adds one empty directory. The `symlink-target` case changes a repository fixture's
link from `first.txt` to `second.txt`, whose contents are identical. The
`executable-bit` case makes an existing file executable while preserving its
contents. All four produce a complete continuation observation with ordinal `0`
and `preFollowUpWorktreeUnchanged: false`.

The `git-private-repository` case writes only
`.git/sevro-fingerprint-probe` in an ordinary cloned repository fixture. Its
corrected public oracle is
`baseline-continuation-fingerprint-git-private-repository.json`, using
`fixture: {"sourceRef":"fingerprint-repo"}` and the existing source-root and
source-map flags. It produces a complete continuation observation with ordinal
`0` and `preFollowUpWorktreeUnchanged: true`. This case requires no generated
fixture support. The source repository remains unchanged.

Every oracle returns exit `0`, completed execution and grading, task `passed`,
the exact second response, complete usage of 17 input and 6 output tokens, and
the two established event artifact hashes. The tests also retain the original
thread and both invocation checks, actual native sandbox probes, private artifact
permissions, credential privacy, and successful workspace/private-state cleanup.

Each case was added only after its predecessor passed. Initial green was observed
with native product code unchanged for every literal command:

- `cargo test -p sevro --test run_native_codex --locked continuation::evidence::records_changed_file_content_before_follow_up -- --exact`
- `cargo test -p sevro --test run_native_codex --locked continuation::evidence::records_added_empty_directory_before_follow_up -- --exact`
- `cargo test -p sevro --test run_native_codex --locked continuation::evidence::records_changed_symlink_target_before_follow_up -- --exact`
- `cargo test -p sevro --test run_native_codex --locked continuation::evidence::records_changed_executable_bit_before_follow_up -- --exact`
- `cargo test -p sevro --test run_native_codex --locked continuation::evidence::ignores_git_private_changes_before_follow_up -- --exact`

These are public characterizations with no product repair. No resource-limit,
concurrent-growth, or simulated OS-failure cases were added. Evidence remains
macOS-only; Ubuntu acceptance is unmeasured locally.

## First passive Claude execution

The unchanged TypeScript public CLI supplied
`baseline-claude-success-minimal.json`, captured with
`observe_claude_success.py --minimal` under the external
`sevro-rust-native-preparation-20261016` artifact directory. The explicit
deterministic Claude executable reads only synthetic authentication. No real
Claude executable, model request, network call, or user credential is involved.

The observed CLI returns exit `0`, completed execution and grading, and task
`passed`. Its final response is `ready`, with SHA-256
`b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6`.
Usage is complete with 1 input token, 2 output tokens, and cost `0.01`.
The required `sevro.claude.events` artifact contains the exact single result
event, has mode `0600`, and has SHA-256
`141bc2c7552bd20c2450c12e8095c2e2f4c3c37d98f3a9257eccdfa82e270e07`.

The fixture checks the exact passive arguments, private credential and settings
files, directory modes, Git-private command home and temporary directory, and
the seven-variable child environment. Explicit credentials suppress inherited
synthetic API and OAuth values. Settings require the native sandbox, deny access
to credential and protected roots, disable hooks, and omit the unrestricted
`Write` tool. Successful workspace and private state are removed; the source
credential is unchanged. These checks prove the supplied settings and process
contract, not actual enforcement by a live Claude sandbox.

Red — `cargo test -p sevro --test run_native_claude --locked executes_passive_claude_with_private_credentials -- --exact`:
the durable public test compiled and failed with expected exit `0`, actual exit
`64`, and `invalid CLI arguments: unknown option --claude-bin`. No Claude product
code had changed before the observation.

Green — the identical command passed one test after adding the explicit Claude
route and private passive host. The implementation shares the existing protected
root, private-file, and owned-process primitives with Codex. Claude rejects
stderr overflow while Codex retains its bounded prefix. Both retain bounded
stdout, invocation cancellation, process-group ownership, and cleanup.

Claude advertises no unported capabilities or collector observations. This slice
requires an explicit binary and credential file; inherited/keychain login,
saved Claude settings, continuation, runtime policy, plugins, native controls,
and passive collectors remain separate work. The actual event artifact supplies
the required evidence. This local macOS result does not establish Ubuntu or live
Claude sandbox acceptance.

## Claude failure controls

Five further unchanged TypeScript CLI runs supplied the finite failure family.
Their complete public results, evidence, retained bytes, modes, launch captures,
and cleanup observations are saved as
`baseline-claude-boundary-{whitespace-credential,nonexecutable-binary,malformed-tail,exit-seven,stderr-overflow}.json`
in the same external artifact directory. Replay one case with
`observe_claude_boundary.py <mode>`. Every run uses the explicit deterministic
binary and synthetic credential; no actual Claude model or network is involved.

All five return exit `2`, execution `failed`, grading `not_requested`, task
`not_assessed`, and `sevro.host.failed`. Their distinct evidence is preserved:

| Input                                                                         | Response and usage evidence                                                      | Process boundary                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Selected whitespace credential, with inherited synthetic API and OAuth values | No raw response or event artifact; usage unknown and incomplete                  | No executable launch and no authentication fallback                |
| Selected binary with mode `0600`                                              | No raw response or event artifact; usage unknown and incomplete                  | No executable launch                                               |
| Valid result followed by JSON `null`                                          | Raw `ready` and the exact event stream retained; usage unknown and incomplete    | The malformed tail invalidates completion                          |
| Valid result followed by process exit `7`                                     | Raw `ready`, the exact event stream, and complete usage 1/2/cost `0.01` retained | Process failure prevents grading despite complete event accounting |
| 65,537 stderr bytes after an owned descendant writes its readiness marker     | No raw response or event artifact; usage unknown and incomplete                  | Claude refuses overflow and the actual recorded descendant stops   |

The malformed-tail event artifact has SHA-256
`31f105bb5e2442472890632a0883ec1918f799cca379cdf4ffb6d4148f27938d`.
The exit-7 event artifact retains the first success oracle's SHA-256
`141bc2c7552bd20c2450c12e8095c2e2f4c3c37d98f3a9257eccdfa82e270e07`.
Both retained raw responses have the established `ready` hash. Retained files
remain mode `0600`; synthetic authentication and overflow stderr stay out of
public output. Failed workspaces remain inspectable, including command home and
temporary directories after launch, while external credential/settings state is
removed. The source credential remains unchanged. Test teardown then removes
its owned failed workspace.

Each durable public case was added only after its predecessor passed. All five
were initially green with native product code unchanged:

- `cargo test -p sevro --test run_native_claude --locked rejects_whitespace_credential_without_authentication_fallback -- --exact`
- `cargo test -p sevro --test run_native_claude --locked rejects_nonexecutable_claude_binary_before_launch -- --exact`
- `cargo test -p sevro --test run_native_claude --locked retains_ready_response_but_invalidates_usage_after_malformed_tail -- --exact`
- `cargo test -p sevro --test run_native_claude --locked retains_measured_evidence_when_claude_exits_nonzero -- --exact`
- `cargo test -p sevro --test run_native_claude --locked rejects_stderr_overflow_and_stops_owned_descendant -- --exact`

These are characterizations, not additional red/green implementation claims.
The fixture's actual child readiness marker precedes overflow; no simulated PID
or sleep-based launch assumption supplies the process oracle. Fixture helpers
are separated from public assertions, and these Claude tests serialize their
native-namespace comparisons. No additional host capability was introduced.
macOS supplied the measured evidence; Ubuntu acceptance remains unmeasured.

## Claude event and credential boundary characterizations

Six unchanged TypeScript public CLI runs supplied the next bounded family.
The external `sevro-rust-native-preparation-20261016` directory retains
`baseline-claude-validation-{invalid-usage,malformed-assistant,missing-credential,oversized-credential,protected-executable-symlink,valid-assistant}.json`.
Each artifact records the literal CLI command, source hashes, public result,
evidence, retained bytes and modes, launch capture, and cleanup. The capture
script is `observe_claude_validation.py <mode>`; it refuses to overwrite an
existing observation. These runs use only deterministic executables and synthetic
credentials, with no hosted model or network activity.

The source oracles are `tests/claude-events.test.ts` (invalid usage, malformed
assistant envelopes, and ordinary text), `src/hosts/claude-events.ts` (valid Skill
input), `tests/claude-credential.test.ts` and
`tests/hosts/claude-runtime-boundaries.test.ts` (explicit credential and protected
executable boundaries). Each source example was exercised through the public
TypeScript CLI before the corresponding Rust test was added.

| Input                                                                       | Observed public outcome                                       | Retained evidence                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `input_tokens: "wrong"` in an otherwise valid result                        | Exit `0`, completed execution/grading, task passed            | Raw `ready` and exact events; both token totals unknown, cost `0.01`, usage incomplete |
| Assistant `message.content: [null]` before a valid result                   | Exit `2`, failed execution, no grading or task assessment     | Raw `ready` and exact events; all usage unknown and incomplete                         |
| Missing selected credential with synthetic ambient API and OAuth values     | Exit `2` before executable launch; no authentication fallback | No response or event artifact; all usage unknown and incomplete                        |
| Selected credential containing 1 MiB + 1 byte                               | Exit `2` before executable launch                             | No response or event artifact; all usage unknown and incomplete                        |
| Executable symlink whose real target is in the protected project            | Exit `2` before executable launch                             | No response or event artifact; target and link preserved                               |
| Valid assistant text and `Skill` tool-use blocks before a successful result | Exit `0`, completed execution/grading, task passed            | Final raw `ready`, exact events, complete usage 1/2/cost `0.01`                        |

The respective retained event hashes are
`0d613a6dfa4f00aa362a02156548d4b4c93136f53dee7c56a1dff4904c703f31`
(invalid usage),
`d9cf2906a3b635d0cf7b609c54b6d8d58bb26aae336c3d277f26c27d18d99147`
(malformed assistant), and
`8eea44a20823e540b15ddcd1c0182a80056dc71e9e97e0489f0dba55481c6c8f`
(valid assistant). Retained raw responses keep the established `ready` hash;
raw and event files remain mode `0600`. The private assistant commentary remains
in its event artifact and does not enter the final response or public summary.
Each failed run retains its workspace for inspection; test teardown then removes
the owned workspace. Successful workspaces and all external private state are
removed. Selected credential contents, including the oversized file, remain
unchanged; a missing selected credential remains absent.

Each case was added after the previous case passed. All six exact commands were
initially green with production code unchanged:

- `cargo test -p sevro --test run_native_claude --locked preserves_response_and_cost_when_token_usage_is_invalid -- --exact`
- `cargo test -p sevro --test run_native_claude --locked retains_ready_response_but_rejects_malformed_assistant_content -- --exact`
- `cargo test -p sevro --test run_native_claude --locked rejects_missing_selected_credential_despite_ambient_authentication -- --exact`
- `cargo test -p sevro --test run_native_claude --locked rejects_credential_larger_than_one_mib_before_launch -- --exact`
- `cargo test -p sevro --test run_native_claude --locked rejects_executable_symlink_into_protected_project -- --exact`
- `cargo test -p sevro --test run_native_claude --locked accepts_text_and_skill_blocks_before_successful_result -- --exact`

These characterize existing behavior; they are not red/green implementation
claims. The last case validates acceptance of the existing stream grammar,
without claiming passive skill collection or adding a capability. The fixture
continues forwarding `LLVM_PROFILE_FILE` to the instrumented Sevro child while
retaining the native command's strict environment. This cohort changes only
Claude tests, their helper, and this ledger. Local macOS evidence does not prove
Ubuntu acceptance or enforcement by a live Claude sandbox.

## Passive Claude session continuation

The unchanged TypeScript CLI supplied two additional inline-fixture oracles:
`baseline-claude-continuation-inline-pass.json` and
`baseline-claude-continuation-inline-foreign-follow-up.json` in the external
`sevro-rust-native-preparation-20261016` directory. Their capture script is
`observe_claude_continuation.py <pass|foreign-follow-up>`. Each records the exact
command, TypeScript source hashes, both launch captures, public evidence, private
artifact bytes/modes/hashes, and cleanup. The inputs adapt the existing
`tests/cli/claude-continuation.test.ts` integration scenario to the already
supported inline fixture; no generated-fixture support was added.

The case declares an initial `Return waiting.` prompt and a
`Resume the same task and return ready.` follow-up, with exact output grading for
`ready`. It requires `sevro.claude.events`, `sevro.claude.initial-events`,
`sevro.claude.follow-up-events`, and `sevro.claude.continuation` evidence. The
synthetic executable validates `--session-id` on the first invocation and
`--resume` on the second, with the same valid UUID. An initial `.git/session-proof`
file is read by the resumed process to establish reuse of workspace, settings,
credential hash, model, effort, and private environment. Both actual launches
are retained in order. This synchronization needs no timing assumption.

The positive TypeScript run exits `0`, completes execution/grading, and passes
the task. Its first result is `waiting`; only the second `ready` response is
graded and retained as the raw response. Usage sums to 4 input tokens, 6 output
tokens, and cost `0.03`, complete. It retains the exact combined event stream and
both phase streams as three mode-`0600` artifacts. The continuation observation
has source `sevro.host.claude`, method `same_session_resume`, the actual session
UUID, completeness `complete`, and measured
`preFollowUpWorktreeUnchanged: true`. Successful workspace and private state are
removed, while the synthetic source credential stays unchanged. Artifact hashes
vary with the generated UUID: the test checks exact event bytes for the captured
session and independently hashes those expected bytes.

Red — `cargo test -p sevro --test run_native_claude --locked continuation::resumes_original_session_and_grades_second_response -- --exact`:
the public test compiled, then failed with expected exit `0`, actual exit `2`,
`sevro.host.failed`, and grading `not_requested`. Production still refused
Claude follow-up at this point.

Green — the identical command passed one test after implementing the bounded
two-turn workflow. Both turns reuse one prepared private state and the existing
owned-process runner/cancellation context. Session binding requires exactly one
matching result per turn. Combined output retains the existing 8 MiB stdout and
64 KiB stderr bounds. The existing Codex workspace fingerprint was moved
unchanged to a shared native module; the continuation observation derives its
value from two actual measurements. Core receipt/persistence types did not
change. Only the generic and Claude continuation capabilities were added to
Claude metadata; typed shutdown behavior was preserved.

The negative TypeScript oracle launches both calls with the same requested
session, but the resumed result names a foreign UUID. It exits `2`, fails
execution, skips grading, and leaves the task unassessed. Raw `ready` and all
three actual event artifacts remain available, but token totals and cost are
unknown and usage is incomplete. Continuation evidence is `partial`, with the
original requested UUID and the measured unchanged-worktree value. The failed
workspace remains inspectable; external private state is removed. The durable
test owns removal of the failed workspace afterward.

`cargo test -p sevro --test run_native_claude --locked continuation::rejects_foreign_follow_up_without_claiming_usage_or_complete_continuation -- --exact`
passed on its first run after the positive implementation. This negative control
is an initial-green characterization, not a separate red/green repair.

These two cases establish a passive follow-up workflow and one essential session
binding refusal. They do not establish the entire Claude failure matrix, native
controls, hooks, runtime policy, passive collectors, or live model behavior.
Only deterministic binaries and synthetic credentials were used. Local macOS
results remain distinct from Ubuntu and live Claude sandbox acceptance.

## Retain Claude stderr on failed turns

Two independently captured unchanged TypeScript CLI runs establish the stderr
receipt boundary. The external artifact directory retains
`baseline-claude-continuation-inline-initial-failure-stderr.json`, replayed with
`observe_claude_continuation.py initial-failure-stderr`, and
`baseline-claude-validation-failed-result-stderr.json`, replayed with
`observe_claude_validation.py failed-result-stderr`. Both synthetic executables
emit a valid `error_during_execution` result with `is_error: true`, followed by
the exact stderr bytes `  synthetic Claude failure stderr\n\n`. Their private
stderr artifact has SHA-256
`6444d62871a699a300d949c07419f77cc5d2f48f15cc15ffd25f8ebccae51ffd`
and mode `0600`; whitespace is preserved, and its body is absent from public
stdout, stderr, and evidence summaries.

Both TypeScript runs exit `2`, fail execution, skip grading, and leave the task
unassessed. Measured usage remains complete at 1 input token, 2 output tokens,
and cost `0.01`. They retain exactly `sevro.claude.events` and
`sevro.claude.stderr`, with the actual raw response. The continuation case
retains `waiting`, launches only the initial UUID-bound turn, and has no resume
capture, phase artifacts, or continuation observation. The single-turn case
retains `ready` and likewise has no continuation observation. Failed workspaces
remain available for inspection, private external state is removed, and source
credentials remain unchanged; the tests then remove their owned workspaces.

The continuation failure's raw `waiting` response has SHA-256
`80cfa3e7f28dde4df64436b652230aff28d7779116d1369c21ef2bbf37261d71`.
Its event bytes include the actual generated session, so the test checks that
session and hashes the exact expected stream. The single-turn result artifact
has SHA-256 `442bd57dd36f923bc97cc48027f4c4d4fbefa40a95a41fe7e891c3b85c00af9f`;
its raw response keeps the established `ready` hash.

Red — `cargo test -p sevro --test run_native_claude --locked continuation::retains_stderr_when_initial_failure_prevents_resume -- --exact`:
the public test compiled and passed its execution, no-resume, usage, and raw
response checks, then failed with one retained artifact instead of the observed
two. Green — the identical command passed after the initial-failure receipt
retained its actual captured stderr.

Only after that green, the independent single-turn oracle was captured and its
test added. Red — `cargo test -p sevro --test run_native_claude --locked retains_private_stderr_from_failed_single_turn -- --exact`:
the test compiled and likewise failed with one artifact instead of two after its
status, usage, and raw-response checks passed. Green — the identical command
passed after the single-turn receipt used the same stderr retention helper.

The helper also preserves existing resumed-turn stderr retention. Empty stderr
still produces no artifact. The process runner, output limits, isolation,
invocation cancellation, core persistence, and capabilities are unchanged.
These are synthetic macOS public CLI observations; no real credentials,
authenticated model calls, or live Claude sandbox claims are involved.

## Current checks

`cargo test -p sevro --test run_native_codex --test run_dry --test run_adapter --locked`
passed all 49 tests at the continuation implementation checkpoint: 28 native,
one dry, and 20 adapter tests.
`cargo clippy --workspace --all-targets --locked -- -D warnings` passed.
Rust formatting, the ledger's Prettier check, and `bun run check:docs` passed.
Temporary shared initializer, cancellation-module, and lint failures were repaired
by their owners; none is presented as native red evidence.

After the failed follow-up characterization,
`cargo test -p sevro --test run_native_codex --locked continuation::` passed both
continuation tests, and
`cargo clippy -p sevro --test run_native_codex --locked -- -D warnings` passed.
The changed test's formatting, ledger Prettier check, and documentation check
passed. Native product sources remained unchanged in this characterization.

After the continuation lifecycle characterizations,
`cargo test -p sevro --test run_native_codex --locked` passed all 32 native tests.
`cargo clippy -p sevro --test run_native_codex --locked -- -D warnings` passed.
The changed test's formatting, ledger Prettier check, and documentation check
passed. Only the continuation test module and this ledger changed in this family.

After the continuation evidence characterizations,
`cargo test -p sevro --test run_native_codex --locked` passed all 41 native tests.
`cargo clippy -p sevro --test run_native_codex --locked -- -D warnings` passed.
The changed tests' formatting, ledger Prettier check, and documentation check
passed. This family changes only the continuation tests, their new evidence test
module, and this ledger; native product sources remain unchanged.

After the fingerprint characterizations,
`cargo test -p sevro --test run_native_codex --locked` passed all 46 native tests.
`cargo clippy -p sevro --test run_native_codex --locked -- -D warnings` passed.
The changed test's formatting, ledger Prettier check, and documentation check
passed. This family changes only the continuation evidence test module and this
ledger; native product sources and shared runtime interfaces remain unchanged.

For the first Claude implementation, its exact public test passed `1/1` and
`cargo test -p sevro --test run_native_codex --locked` passed all 46 existing
native tests after the common-helper extraction. The previously completed
46-test green supplies the pre-extraction comparison. An attempted duplicate
pre-extraction run exceeded the shell wrapper's 120-second limit during the
shared execution stall; it is not behavioral failure evidence. Its abandoned
test process and observed descendants were subsequently confirmed absent.
Later native commands use polled process sessions.
Scoped Rust formatting, the ledger's Prettier check, and `bun run check:docs`
passed at the first-success hold point.

After the five Claude controls and fixture-helper organization,
`cargo test -p sevro --test run_native_claude --test run_native_codex --locked`
passed all 52 native tests: 6 Claude and 46 Codex.
`cargo clippy -p sevro --lib --test run_native_claude --test run_native_codex --locked -- -D warnings`
passed. Scoped Rust formatting, the ledger's Prettier check, and
`bun run check:docs` passed. Native product behavior remained unchanged throughout
the five-control cohort. Broader repository acceptance remains the coordinator's
separate candidate-bound gate.

After the six event and credential boundary characterizations,
`cargo test -p sevro --test run_native_claude --test run_native_codex --locked`
passed all 58 native tests: 12 Claude and 46 Codex.
`cargo clippy -p sevro --lib --test run_native_claude --test run_native_codex --locked -- -D warnings`
passed. The two owned Rust test files passed scoped `rustfmt --check`; this
ledger's Prettier check and `bun run check:docs` passed. No production repair,
shared runtime change, dependency change, or additional capability was needed.

After passive Claude continuation and its foreign-session control,
`cargo test -p sevro --test run_native_claude --test run_native_codex --locked`
passed all 60 native tests: the previous 58 plus two continuation cases.
`cargo clippy -p sevro --lib --test run_native_claude --test run_native_codex --locked -- -D warnings`
passed. These commands used the separate
`CARGO_TARGET_DIR=/Users/bjro/.codex/artifacts/sevro-rust-native-preparation-20261016/target-claude-continuation`.
Scoped Rust formatting with `skip_children=true`, ledger Prettier checking, and
`bun run check:docs` passed. The common process, isolation, transport, options,
schemas, dependencies, and `run.rs` were not changed by this slice.

After the failed-turn stderr repairs,
`cargo test -p sevro --test run_native_claude --test run_native_codex --locked`
passed all 62 native tests: 16 Claude and 46 Codex, using the same dedicated
target directory. Both new exact commands have independent observed reds and
greens. Strict scoped Clippy with the preceding native targets, owned-path
`rustfmt --check --config skip_children=true`, ledger Prettier checking, and
`bun run check:docs` passed. No common process or isolation changes were needed.

## Linux temporary Git mount placeholder

The unchanged TypeScript protection code ignores a real, empty `.git` directory
only at Linux `/tmp` or the invoking process's temporary directory. Files,
symlinks, nonempty directories, and metadata in other directories remain subject
to ordinary protected-worktree discovery. Codex's Linux sandbox can leave this
empty mount placeholder behind; treating it as a repository prevents later
native trials from reaching execution.

The Linux-only public regression
`temporary_metadata::ignores_empty_git_mount_placeholder_in_temporary_root`
owns its temporary root and empty `.git`, uses synthetic credentials and an
explicit deterministic Codex wrapper, and first invokes the unchanged TypeScript
CLI. It requires completed execution, `ready`, complete 12/4 usage, the exact
event artifact, unchanged credentials and metadata, and private-state/workspace
cleanup before invoking Rust with the same CLI arguments and temporary root.
It has no prerequisite skip on supported Ubuntu.

Red — `cargo test --workspace --all-targets --locked --no-fail-fast` on
[`013e480` Ubuntu stable job 117180739277](https://github.com/BjRo/sevro/actions/runs/38962482404/job/117180739277):
the paired TypeScript invocation completed, then Rust returned exit `2` instead
of `0` with the fixed diagnostic stage `prepare-git-worktrees`. This is an actual
public behavior failure, independently observed before the isolation repair.
The full job had other failures; this regression does not establish their causes.

The repair adds the same Linux-only exception during protected-root ancestor
inspection. It uses symlink metadata, so a symlink to an empty directory cannot
receive the exception. Directory-read failure still refuses preparation. Native
sandbox permissions, credential handling, and protected-root expansion are
unchanged.

The focused Linux command remains
`cargo test -p sevro --test run_native_codex --locked temporary_metadata::ignores_empty_git_mount_placeholder_in_temporary_root -- --exact`.
Linux green is pending the repaired candidate's CI run. macOS compilation or
regressions do not execute this platform-specific case. The separate nested
sandbox exit-96 investigation remains unresolved; this repair does not claim to
explain it. Temporary diagnostic instrumentation remains tracked for removal
after the observed causes are resolved.

Local macOS regression checks passed:
`cargo test -p sevro --test run_native_claude --test run_native_codex --locked`
ran all 64 existing native tests, including corrupt/unreadable protected Git
metadata, linked worktrees, and stale registrations.
`cargo clippy -p sevro --lib --test run_native_claude --test run_native_codex --locked -- -D warnings`
and scoped Rust formatting passed. These checks preserve the existing behavior;
they do not establish Linux acceptance for the repaired exception.
