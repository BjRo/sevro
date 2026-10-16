# Rust runtime and native host parity

This reference specifies the runtime, isolation and native-host behavior that
the Rust runner must preserve. It derives expected outcomes from the existing
tests at baseline commit `1400f3f`, alongside the
[runtime v1 contract](../runtime-v1.md),
[native host reference](../native-hosts.md),
[Codex host reference](../codex-host.md) and
[results/evidence contract](../results-v1.md).
It is a compatibility oracle for the requested Rust port, not evidence that a
Rust implementation or an authenticated native trial has passed.

## Scope and use

The inventory covers 36 suite files and 474 test declarations, including every
file in `tests/runtime/` and `tests/hosts/`, the top-level runtime/host/event/
authentication/control/skill suites and both outer sandbox suites. Parameterized
declarations include every member of their source matrix; the dynamic native
locale declaration expands to both Codex and Claude. Counts describe declarations,
not expanded test runs. Fixture scripts and native peer programs are inputs to
these assertions, not additional claims of authenticated model behavior.

Each RH section defines independently expected outputs and side effects at
public execution, filesystem/process or serialized evidence seams. The following
table in that section maps its exact original test names and baseline line
numbers to those requirements. Read the linked source matrix for each `%s`,
`%j` or `$name` expansion and retain every case when porting. Test titles and
locations were extracted from the original TypeScript syntax; their wording is
verbatim. Line numbers are baseline locations and are not stable after edits.

General CLI/evaluation/report/fixture/extension and guide-evaluation behavior is
specified by the other Rust parity references; this file includes the runtime
CLI and native host tests even when their seam is the CLI. The migration must
preserve the existing features and public v1 protocol/cases. The final runner
owns orchestration, isolation, evidence and host behavior in Rust. A transitional
TypeScript adapter bridge cannot become a permanent Bun implementation of this
core. This document does not authorize changing the separate Darrow repository.

## Cross-cutting acceptance invariants

- Preserve success, failure, cancellation, unavailable, partial and unknown as
  distinct states. A valid root answer is not proof that every optional observer
  completed; missing/ambiguous evidence cannot prove absence or turn a required
  check into a pass.
- External inputs are validated before execution, provider queries, hashing or
  copying when the corresponding boundary requires it. Refusals preserve the
  existing observable exit/status category and useful diagnostics without
  exposing credential bytes.
- Lexical paths, canonical targets and future sibling state all matter.
  Ordinary read-root declarations cannot opt into the runner's private
  namespace. Narrow transcript/artifact/plugin exceptions must be bound to the
  actual current request or trial and remain read-only.
- Private mutable role/trial state is separate from source, evaluators, peer
  fixtures, credentials and host configuration. Tests must actually attempt
  reads, writes, creation, deletion and alias access; inspecting profile text
  alone cannot prove a sandbox boundary.
- Own the subprocess lifecycle through cancellation, deadlines and cleanup.
  Native/hook descendants terminate before their private roots disappear.
  Persist available diagnostic/transcript evidence before cleanup, and retain
  the original failure if cleanup also fails.
- Preserve byte/count/time bounds and partial-state reporting at the named
  seams. Do not conflate raw process bytes with safe decoded public diagnostics
  or raise bounds only to accommodate an implementation.
- Snapshot declared runtime values, tool discovery and seed digests into
  configuration identity. Temporary paths and unretained private bytes must not
  destabilize comparison identity.

## Required environments and limits of evidence

Maintain macOS arm64 and Ubuntu 24.04 x64 support from the first migration
slices. macOS probes use native `sandbox-exec`, installed Codex/Claude and
Apple Command Line Tools for the libc fixture. Ubuntu probes require working
unprivileged bubblewrap namespaces, ripgrep and socat; use the
[repository CI setup](../../scripts/setup-ci-linux.sh).
The current source gate's pinned Bun, Node and native host versions are recorded
in [TypeScript quality](../typescript-quality.md#environment-and-ci).
A Rust gate must retain equivalent real process/native isolation coverage on
both platforms while the existing gate remains required during transition.

Platform guards are part of the test inventory: Apple discovery and Keychain
run only on macOS, Linux mount semantics run on Ubuntu, and unreadable-path
probes need a non-root user. A skipped test, early return for a missing
prerequisite, successful opposite-platform run or historical green commit does
not prove the corresponding behavior on the Rust candidate. Windows and other
Linux distributions remain unverified; Windows support is not a port
requirement.

Live model tests retain their explicit opt-in flags. Deterministic native
protocol fixtures and actual sandbox/hook probes establish their tested
boundaries, not authenticated model success. Native tool/version changes require
fresh evidence; requested model/effort are not invented observed child routing.
Codex body-exposure receipts have their stated observational limits, and Claude
direct Read/command expansion are not synthesized into Skill activations.
Local HTTP on macOS can reach other available loopback services; it is not a
separate per-trial loopback namespace.

## Test-first implementation slices

| Slice                                             | Stable test seam and independent oracle                                                                                                                               | Dependencies                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Runtime policy                                    | Load real configuration files; assert exact selected environment, paths, digest changes, errors and no pre-validation side effects.                                   | Public schema/identity port.                             |
| Host-independent filesystem and process ownership | Launch real children and sandbox probes; assert permitted fixture operations, denied roots, deadlines, process death and cleanup.                                     | Runtime policy; macOS and Ubuntu executors.              |
| Native event summaries and portable observations  | Feed retained native wire fixtures and assert independently specified summaries, labels, unknown/partial states and redaction.                                        | Bounded UTF-8/JSONL readers.                             |
| Codex exec and Claude adapters                    | Launch deterministic native peers plus real native preflight; assert auth precedence, generated permissions, request validation, outputs and artifacts.               | Process ownership, runtime policy and event summaries.   |
| Codex app-server                                  | Exchange real JSON-RPC peer messages including adversarial settlement races; assert one bound root, exact feedback turns and terminal readback.                       | Codex adapter and wire validation.                       |
| Plugin projection and hooks                       | Prepare declared plugin packages and run installed native hook paths; assert selected side effects, source digests, credential/network denial and descendant cleanup. | Native adapters, namespace ownership and seed snapshots. |
| Skill and agent evidence                          | Replay retained native sessions and passive hook lifecycles; assert exact independent receipt facts, pagination ambiguity and privacy.                                | Native adapters and bounded evidence storage.            |
| Retained candidate evidence                       | Execute candidates creating actual artifacts/state/transcripts, then shell/native graders; assert read-only original bytes and cleanup on every terminal path.        | All relevant runtime/native lifecycle slices.            |
| Diagnostics and full regression                   | Trigger every lifecycle-stage failure and inspect private artifacts; run both OS gates on the exact published PR commit.                                              | All implemented slices; unchanged full acceptance scope. |

Each slice starts with one failing behavioral test before production changes,
then broadens only after that oracle passes. Use existing deterministic fixtures
as external inputs, not the TypeScript implementation to compute expected Rust
results. Differential runs may add evidence but cannot replace the independent
expectations below. Keep all baseline tests active during transition; any
temporary compatibility adapter must preserve the same behavior.

## RH01: Claude authentication through the CLI

Source: [tests/claude-auth-cli.test.ts](../../tests/claude-auth-cli.test.ts).

The public CLI accepts inherited OAuth and API credentials and reuses saved login credentials before querying Keychain. Explicit credential selection takes precedence; a missing or oversized selected file fails execution with exit 2 and task verdict `not_assessed`, without silently trying a different login. Without explicit file selection, valid environment authentication takes precedence over an invalid saved credential. Successful fixture authentication exits 0 and passes its task. Neither public results nor run evidence may contain the synthetic OAuth, API or file secrets.

| Baseline line | Exact test declaration                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| 143           | public CLI reuses existing Claude environment authentication                 |
| 163           | public CLI reuses the saved Claude login before Keychain                     |
| 186           | public CLI preserves explicit credentials and refuses invalid selected files |

## RH02: Private Claude credential staging

Source: [tests/claude-credential.test.ts](../../tests/claude-credential.test.ts).

Staging preserves the selected file's bytes in a newly created private file with mode 0600. Reusing the same private destination is refused. Missing input and input exceeding 1 MiB fail with the unavailable/unreadable credential diagnostic. The port must retain the creation and permission boundary, not merely deserialize an equivalent credential.

| Baseline line | Exact test declaration                                        |
| ------------- | ------------------------------------------------------------- |
| 12            | Claude login staging copies bounded bytes into a private file |
| 23            | Claude login staging rejects absent and oversized input       |

## RH03: Claude event summaries

Source: [tests/claude-events.test.ts](../../tests/claude-events.test.ts).

A successful, well-formed result stream with process exit 0 yields the final result text. Sum input, cache-creation and cache-read token buckets across results; sum output tokens and available costs. The fixed two-result oracle is 51 input tokens, 26 output tokens and USD 0.3, with only `Final public result` as final text. A failed final result/process remains incomplete while its final text and valid usage remain available. Missing or invalid usage yields null token counts and `usageComplete: false`; it does not erase an otherwise valid final answer or cost. Empty streams have no answer and are incomplete. Invalid JSON/event envelopes, malformed assistant messages/content/tool blocks and primitive events cannot establish complete execution or usage. Ordinary assistant text is not the final answer and is not copied into summary evidence. Streams over 8 MiB are refused.

| Baseline line | Exact test declaration                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| 23            | Claude stream accounting sums cache buckets and keeps the final result       |
| 58            | a failed result or malformed event cannot complete a Claude turn             |
| 98            | missing usage stays unknown while the final answer remains available         |
| 124           | Claude event streams have a hard byte limit                                  |
| 130           | malformed assistant envelopes cannot establish completed Claude evidence: %j |
| 153           | ordinary assistant text blocks preserve the validated final Claude result    |

## RH04: Claude host execution and evidence

Source: [tests/claude-host.test.ts](../../tests/claude-host.test.ts).

Managed fixtures remain usable inside the private namespace. The host runs with native sandboxing, `dontAsk` permissions, selected plugin directories and the declared setting-source route. The observed tool set is `Bash,Read,Edit,Skill,Agent`; do not substitute an unsandboxed route or import unrelated user settings. The valid fixture returns `ready`, complete execution, `sevro.claude.tool-calls`, portable native controls and private `sevro.claude.events` evidence.

A complete bound native session can prove no native goal: an empty goal list and null status. Missing, invalid or failed session evidence reports unavailable goal evidence, never successful absence; child goals do not become root goals. Failed execution retains original private artifact bytes in mode-0600 files, produces exit 2, failed execution, no grading/checks and `not_assessed`, and omits private diagnoses from public results. A repository command needs the explicit project-settings route and a verified native dispatch receipt. Successful dispatch does not by itself create a Skill activation; the fixture's real successful Skill result does. Duplicate or mismatched invocations, undeclared plugin roots and escaping package paths are refused.

| Baseline line | Exact test declaration                                                  |
| ------------- | ----------------------------------------------------------------------- |
| 79            | Claude managed workspaces remain usable under the namespace policy      |
| 120           | Claude complete native session records bounded goal absence: %s         |
| 148           | Claude unavailable native goal evidence cannot establish absence: %s    |
| 177           | failed Claude execution retains private evidence without grading        |
| 261           | Claude host runs with native sandbox settings and declared plugins      |
| 372           | Claude host observes a bound native repository command without a plugin |
| 479           | Claude host refuses undeclared and escaping plugin packages             |

## RH05: Claude repository dispatch receipts

Source: [tests/claude-repository-invocation.test.ts](../../tests/claude-repository-invocation.test.ts).

Accept only a leading mounted command whose exact arguments, session, complete mounted body and transcript ordering bind to a subsequent assistant response. Both native string content and text-block arrays are supported, as are commands without arguments and newline-delimited leading arguments. A command embedded after ordinary prompt text is rejected. Empty metadata-only bodies, missing terminal assistant evidence, malformed JSON and unavailable transcripts remain unknown/partial. Wrong command, arguments, session, body or order produces a negative receipt, not a positive dispatch. Duplicate sessions, redirected transcript/skill paths and missing skills cannot establish acceptance. Public receipts retain skill name, method, acceptance and reason, without mounted bodies or an invented activation list.

| Baseline line | Exact test declaration                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------- |
| 50            | Claude repository dispatch accepts native text block arrays without retaining bodies            |
| 73            | Claude repository dispatch accepts a command with no arguments                                  |
| 101           | Claude repository dispatch does not accept a command embedded after ordinary prompt text        |
| 114           | Claude repository dispatch leaves a metadata-only mount unavailable                             |
| 124           | Claude repository mount accepts a newline-delimited leading command and refuses a missing skill |
| 152           | Claude repository dispatch binds exact arguments, session, body, and order                      |
| 220           | Claude repository observation refuses unavailable, duplicate, or redirected evidence            |

## RH06: Claude permission settings

Source: [tests/claude-settings.test.ts](../../tests/claude-settings.test.ts).

Generated settings enable native sandboxing, disallow unsandboxed commands, fail when isolation is unavailable and disable hooks by default. Bash filesystem permissions and Read/Edit tool permissions deny private state, source and result roots; curated plugin roots are read-only. The credential file receives an explicit deny rule. Bash and Agent remain available through the intended tool policy. Relative, malformed and escaping private/configuration paths are refused before a profile can grant access.

| Baseline line | Exact test declaration                                         |
| ------------- | -------------------------------------------------------------- |
| 4             | Claude host settings deny private state to Bash and file tools |
| 56            | Claude host settings reject escaping and malformed state paths |

## RH07: Claude activation collector

Source: [tests/claude-skill-activations.test.ts](../../tests/claude-skill-activations.test.ts).

Only a successful structured Skill result paired by session, actor and tool-use identity yields a qualified activation. Preserve qualified names, call status and parent-tool identity while omitting arguments, results and skill bodies. Failed calls and textual mentions yield no activation. Identical repeated messages are idempotent; conflicting invocations/statuses make collection partial, retaining the latest status and existing independently supported positives. Unmatched attempts, another actor's result, missing identity, invalid inputs/statuses, malformed blocks/streams and failed execution remain partial. An omitted `is_error` on an otherwise valid result is accepted by the baseline. Retain at most 128 calls/skills, set `truncated`, preserve the bounded prefix and keep collection partial on overflow.

| Baseline line | Exact test declaration                                                                     |
| ------------- | ------------------------------------------------------------------------------------------ |
| 37            | successful Skill results identify qualified activations without retaining private text     |
| 56            | failed Skill tools and mentions do not become activations                                  |
| 70            | unmatched attempts and results from another actor remain partial                           |
| 82            | repeated messages are idempotent and conflicting invocations remain partial                |
| 98            | missing identity and malformed result status cannot establish complete activation evidence |
| 114           | malformed streams and failed execution remain partial                                      |
| 123           | invalid Skill inputs and primitive events cannot establish complete evidence               |
| 137           | malformed blocks retain successful evidence while making collection partial                |
| 161           | conflicting result statuses make collection partial and retain the latest status           |
| 175           | Skill call overflow preserves the bounded prefix and reports partial evidence              |

## RH08: Claude tool-call receipts

Source: [tests/claude-tool-calls.test.ts](../../tests/claude-tool-calls.test.ts).

Retain ordered Skill and Agent facts, parent/nested actor identity and tool-use IDs. Ordinals count unrelated native tools as well; filtering does not renumber calls. Normalize native Task to Agent. Skill evidence retains short skill and qualified invocation; Agent evidence retains bounded route/model/background values plus SHA-256 of the prompt and its first line, never prompt text. Accept both supported snake-case and serialized camel-case route metadata. Nonobject input, malformed actor/envelope metadata, invalid or oversized UTF-8 prompts and incomplete turns cannot prove absence; unknown fields remain null. A complete successful turn with no relevant calls is complete empty evidence. Retention overflow keeps 128 calls and explicit truncation, hence partial evidence.

| Baseline line | Exact test declaration                                                            |
| ------------- | --------------------------------------------------------------------------------- |
| 21            | Claude retains ordered Skill and Agent facts without their prompts                |
| 106           | Claude Agent prompt evidence stays a digest and requires a bounded string         |
| 124           | Claude Task tool is normalized to an Agent receipt                                |
| 151           | a complete turn with no Skill or Agent call proves absence                        |
| 166           | invalid call metadata and incomplete turns cannot prove absence                   |
| 183           | excessive call metadata is truncated and cannot prove absence                     |
| 198           | malformed assistant or actor context cannot prove Claude tool absence: %j         |
| 212           | Claude tool ordinals include unrelated tool calls without retaining their input   |
| 235           | Claude nonobject Agent input cannot establish a dispatch receipt: %s              |
| 259           | Claude accepts the serialized camel-case agent route while bounding UTF-8 prompts |

## RH09: Codex event summaries

Source: [tests/codex-events.test.ts](../../tests/codex-events.test.ts).

Require exactly one root `thread.started` before turn completion. The last completed agent message supplies the final text; a message without string text supplies no answer. Completed usage is final cumulative usage rather than a sum of intermediate events: the fixture oracle is thread `thread-1`, answer `done`, 12 input and 4 output tokens. Nonzero exit or any failed turn makes execution incomplete. Missing or malformed final usage stays null/unknown even when execution completed. Duplicate/missing root starts, completion before a root, invalid JSON, nonobject/untyped events and streams over 8 MiB fail closed. A root start without a completed turn is incomplete.

| Baseline line | Exact test declaration                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| 13            | a complete Codex turn reports its identity and final cumulative usage         |
| 33            | exit failure, turn failure, and missing usage cannot become complete evidence |
| 56            | the last completed agent message is the final response                        |
| 78            | malformed, ambiguous, and oversized event streams fail closed                 |
| 90            | malformed final cumulative usage stays unknown: %j                            |
| 106           | nonobject or untyped serialized Codex event cannot complete: %j               |
| 118           | a stream without any root start cannot claim a participant thread             |

## RH10: Codex host lifecycle, plugins and continuation

Source: [tests/codex-host.test.ts](../../tests/codex-host.test.ts).

Host options require absolute executable/authentication paths, nonempty model/effort, an integral positive timeout no greater than 30 minutes and, when supplied, a positive safe integer agent concurrency limit. Requests reject empty follow-ups, unsupported instrumentation/enforcement, external fixture-bin paths and unsupported fixture-local configuration before candidate launch. Selected authentication is authoritative: missing, directory or oversized auth input cannot fall back. A physical fixture `.codex` directory is accepted only through the state opt-in; a file at that path is always refused.

Validate marketplace declarations, package roots/files, manifest identity and local source before launching: duplicates, mismatches, links, relocation, missing/undeclared files and absent invoked skills are errors. Install curated plugins in private native state, remove unauthorized command hooks, preserve intended prompt/plugin permissions and remove projections after preparation failure or cancellation. Hook-free/unselected-command plugins must not hash or copy hook dependencies merely because seeds exist. Explicit plugin/repository invocation must bind one exact allowed token and verified safe skill; emit `sevro.codex.explicit-invocation` separately from activation evidence. Failed app-server execution cannot produce a complete dispatch receipt.

Use strict configuration and the native permission profile, including actual sandbox/executable preflight; never use the bypass-sandbox flag. One combined preflight invocation establishes isolation and executable usability, distinguishes exit 70 from 71, supports startup beyond ten seconds within its 60-second bound, and preserves stderr/cause/termination evidence. Failed candidate preflight yields exit 2; semantic preflight failure yields exit 3; SIGTERM cancellation during semantic preflight remains cancelled with exit 143. Fixture tools survive login-shell PATH setup. Protected project executables are refused. Stale temporary fixtures do not enlarge the profile.

A declared follow-up resumes the original thread, persists the initial session, captures both event artifacts and returns the follow-up answer. Complete usage is combined (fixture oracle 17 input/6 output); any unknown turn usage makes combined usage unknown. Continuation evidence records the native ordinal and whether non-Git workspace contents changed; Git-private state is ignored, unreadable fingerprints remain unknown and a different resumed thread is refused. Timeouts and cancellation stop the owned process group. Preserve native-call/control and body-exposure collector observations; pagination may combine exact nonambiguous fragments only within the same session/turn. Missing/changed/holey/repeated/foreign pages and matching limits remain partial; reverse/overlapping exact pages and a later full body can complete exposure.

| Baseline line | Exact test declaration                                                            |
| ------------- | --------------------------------------------------------------------------------- |
| 51            | Codex host refuses $label configuration                                           |
| 211           | Codex host collects runner-owned hooks independently of command syntax            |
| 297           | Codex host accounts for paged tool results                                        |
| 315           | incomplete paged tool results stay unknown: $name                                 |
| 368           | complete paged tool results tolerate $name                                        |
| 394           | paged tool results with identical skill bodies remain ambiguous                   |
| 410           | repeated page text cannot prove different body positions were exposed             |
| 427           | paged matching limits keep evidence unknown: %j                                   |
| 445           | Codex state opt-in still refuses a configuration path that is a file              |
| 462           | Codex continuation stays partial when the workspace fingerprint cannot be read    |
| 484           | failed app-server execution cannot yield a complete owner-dispatch receipt        |
| 529           | Codex host retains Code Mode $name evidence                                       |
| 724           | Codex marketplace refuses %s before model execution                               |
| 757           | Codex installed plugin refuses an invoked skill missing from its declared package |
| 775           | Codex selected authentication %s refuses execution without fallback               |
| 792           | Codex request refuses %s before candidate launch                                  |
| 828           | CLI refuses a Codex configuration directory that is a regular file                |
| 871           | Codex host refuses an otherwise valid stream without a completed turn             |
| 883           | Codex continuation keeps combined usage unknown when the initial turn omits usage |
| 897           | Codex host binds bounded native calls to its completed thread                     |
| 935           | Codex host resumes a second prompt in the initial thread                          |
| 1008          | Codex continuation ignores Git-private fixture state at the boundary              |
| 1043          | Codex host refuses a continuation from another thread                             |
| 1069          | Codex prepares a hook-free native plugin in a managed workspace: %s               |
| 1136          | Codex removes private plugin projections after %s                                 |
| 1209          | Codex host installs a declared local plugin in its isolated home                  |
| 1330          | Codex host dispatches a verified repository skill without a plugin                |
| 1403          | Codex host verifies its permission profile and feeds the engine                   |
| 1473          | Codex fixture tools survive login-shell PATH setup                                |
| 1522          | Codex host rejects malformed streams and unsupported enforcement                  |
| 1551          | Codex host terminates a timed out turn                                            |
| 1573          | Codex host kills its process group when cancelled                                 |
| 1617          | Codex host refuses an executable inside a protected project                       |
| 1640          | Codex without authorized command hooks does not read hook dependencies            |
| 1667          | Codex sandbox profile does not grow with stale temporary case folders             |
| 1696          | Codex %s preflight failure retains its cause and process evidence                 |
| 1789          | Codex preflight retains a bounded stderr prefix without failing on overflow       |
| 1826          | Codex semantic preflight cancellation stays cancelled with transcripts %s         |
| 1909          | Codex preflight timeout retains termination evidence                              |
| 1962          | Codex runs one sandbox invocation for isolation and executable preflight          |
| 1986          | Codex refuses combined sandbox probe failure %s before participant execution      |
| 2011          | Codex permits bounded sandbox startup beyond ten seconds                          |
| 2029          | Codex preserves omitted dependency source isolation in grading policies           |
| 2058          | Codex refuses invalid programmatic seed role selection $roles                     |
| 2083          | Codex skips dependencies for plugins without authorized command handlers: %s      |

## RH11: Codex native sessions and Code Mode controls

Source: [tests/codex-native-calls.test.ts](../../tests/codex-native-calls.test.ts).

Read only one complete, uniquely bound native session with strictly ordered integral ordinals and valid object payloads. Missing sessions report unavailable; malformed, ambiguous, linked, unreadable, invalid-UTF-8 or oversized sessions cannot prove absence. Preserve invocation-attempt labels and ordinals without private arguments. Accepted spawn evidence requires one matching request, native start and result, retaining request/start/accept ordinals, agent reference and child thread plus bounded optional requested route fields. Optional invalid route fields do not erase independently established acceptance. Malformed request arguments retain an attempt with no accepted spawn.

Child-session availability and child result completion are separate. A completed result needs one nonempty final text bound to its turn; missing, duplicate, malformed or nontext answers remain unavailable without retaining answer text. Root/self/parent reuse cannot prove an independent child. Retain at most eight inspected children and eight nested spawn requests with explicit truncation. Nested receipts preserve accepted/unaccepted status, requested reader route and independently supported session/result status.

Feedback receipts retain tool label, target, ordinal and unique response presence. Plaintext equality with the declared follow-up is an explicit boolean; absent context stays null. Encrypted or malformed messages cannot be compared. Duplicate/missing responses do not prove response presence. Never retain feedback text or tool-result bodies.

Code Mode receipts recognize bounded static submissions, including direct calls, literal/template arguments, supported template/string composition, Promise.all/allSettled arrays, destructuring and the tested for-of/forEach(text) forms. Preserve actual submitted call order and namespace while treating source text, shell commands and comments as data. A submitted spawn is not accepted merely because its JavaScript appears in the session: rejected attempts remain labeled and accepted-agent count is zero. Require one attributable successful structured completion, including the supported native text-array envelope. Missing/duplicate/error/running/truncated/wrong-call outputs remain partial. Dynamic lookup, aliases/shadows, conditional/callback launches, nested executors, spread/getters, unsupported bindings, malformed source and byte/node/call limits stay partial with unknown counts. Golden retained fixtures cover direct ordinals 45/69/77 and coupled ordinals 30/68; their exact call lists are the oracle, without retaining source, command text or private paths.

| Baseline line | Exact test declaration                                                                       |
| ------------- | -------------------------------------------------------------------------------------------- |
| 20            | Code Mode recovers retained direct ordinal 45 template commands                              |
| 45            | Code Mode recovers retained coupled ordinal $ordinal batch results                           |
| 74            | Code Mode recovers retained direct ordinal %s patch and template output                      |
| 99            | Code Mode retains submitted spawns with template arguments and batch composition             |
| 120           | Code Mode traverses tool calls in composed output: %s                                        |
| 141           | Code Mode keeps ambiguous binding or composition partial: %s                                 |
| 197           | Code Mode cannot establish complete control evidence from unsupported bindings: %s           |
| 216           | Code Mode requires a bound structured completion before its control evidence is complete: %j |
| 243           | Code Mode refuses $label as attributable control evidence                                    |
| 286           | Code Mode keeps $label unavailable                                                           |
| 342           | Code Mode cannot prove absence with $label                                                   |
| 378           | Code Mode text and command bodies cannot invent native controls                              |
| 417           | Code Mode accepts native array completion envelopes                                          |
| 455           | Code Mode refuses malformed or truncated completion envelopes: %s                            |
| 492           | Code Mode inspects the retained Darrow parallel read shapes: %s                              |
| 534           | Code Mode portable controls preserve rejected attempts and opaque evidence: %s               |
| 581           | Code Mode exposes completed literal tool submissions without private inputs                  |
| 638           | native boundary uses only a complete, unique session                                         |
| 654           | native goal and agent calls retain names and order without private arguments                 |
| 783           | native spawn acceptance binds one request, start, and result                                 |
| 807           | accepted child sessions distinguish available, malformed, and ambiguous rollouts             |
| 844           | accepted child completion binds one nonempty final message to its turn                       |
| 897           | nested spawn receipts bind the accepted reader and completed session                         |
| 1008          | nested request truncation is explicit                                                        |
| 1028          | child session lookup is capped with an explicit truncation flag                              |
| 1061          | native spawn route fields stay bounded even when host acceptance succeeds                    |
| 1085          | native tool calls retain order and feedback target without private input                     |
| 1122          | native feedback retains target and unique response without message text                      |
| 1206          | native feedback requires string labels in retained evidence                                  |
| 1233          | ambiguous, mismatched, and malformed spawn evidence cannot establish acceptance              |
| 1252          | missing, ambiguous, and malformed native sessions cannot prove absence                       |
| 1272          | native session traversal refuses links and oversized content                                 |
| 1286          | native malformed serialized spawn arguments cannot establish acceptance: %s                  |
| 1301          | accepted spawn identity survives absent optional requested route fields                      |
| 1313          | child completion cannot bind malformed final content: %j                                     |
| 1351          | nested spawn cannot use its root or parent session as reader evidence: %s                    |
| 1388          | a spawn pointing back to the root cannot establish an independent child session              |
| 1403          | a nested invocation with malformed arguments records an unaccepted reader attempt            |
| 1422          | invalid UTF-8 and oversized child bytes preserve partial evidence without a completion       |

## RH12: Codex native command permissions

Source: [tests/codex-profile.test.ts](../../tests/codex-profile.test.ts).

Create a valid profile only from absolute protected paths and a valid profile ID; reject control characters before configuration serialization. Quoted paths must round-trip through TOML, roots are deduplicated and command environment inheritance is disabled. Supply private HOME/TMPDIR/TMPPREFIX and `approval_policy = "never"`. Source/auth/private state remain denied, fixture writes and declared executable reads remain usable. A narrow native plugin read grant cannot expose its role root, namespace, authentication or siblings. Linux uses an empty filesystem root when necessary; explicit namespace deny remains when a broader baseline or custom temp root would otherwise expose it. Real native Codex sandbox probes must read/write the fixture, deny source/auth reads and execute the installed Codex binary.

| Baseline line | Exact test declaration                                                      |
| ------------- | --------------------------------------------------------------------------- |
| 67            | Codex profile refuses $label before creating a command policy               |
| 76            | Codex profile refuses control characters in a filesystem policy value %j    |
| 88            | Codex profile preserves quoted paths and deduplicates declared access roots |
| 122           | Codex profile denies roots and strips command credentials                   |
| 147           | Codex profile keeps private siblings closed around a narrow native read     |
| 165           | Codex profile retains the namespace deny under a broader read baseline      |
| 178           | Codex profile keeps private denial when the native temp root is custom      |
| 196           | actual Codex sandbox keeps fixture access and denies source and auth        |

## RH13: Native diagnostics and cleanup ordering

Source: [tests/host-diagnostics.test.ts](../../tests/host-diagnostics.test.ts).

Persist private `sevro.host.diagnostics` before native state disappears, including failures before any session exists and without transcript opt-in. Retain host/role, specific stage, error and cause plus bounded process receipts: code or null, signal or null, reason, duration and stdout/stderr. Distinguish request-validation, state-preparation, marketplace-install, plugin-install, hooks-preparation, isolation-preflight, exec/app-server/claude-execution, result-processing and cleanup. Spawn failure keeps code/signal null; a successful subprocess followed by result processing failure keeps the process's success and the later failing stage. Preserve the original execution failure if cleanup also fails.

Candidate failure yields exit 2 and no assessment; semantic failure yields exit 3; failed advisory review remains advisory and can leave task exit 0. Public failure results expose the retained diagnostic artifact location, not raw private output. Diagnostic persistence failures, including secondary hosts, remain internal runner failures rather than ordinary native failure verdicts.

Capture mode-0600 artifacts, cap retained stream prefixes to 65,536 bytes at UTF-8 boundaries, flag truncation, redact configured and inherited opaque credentials, Authorization-like values and secrets cut by the cap. Preserve the original diagnostic prefix. Native transport stderr tails are a separate surface. Journal retention is bounded to 32 processes with a dropped count and remains below the 8-MiB artifact budget; keep the final failing receipt. Timeout retains partial output and actual SIGKILL termination. Transcript opt-in produces an unavailable empty bundle on pre-session failure; absent opt-in produces no bundle.

| Baseline line | Exact test declaration                                                         |
| ------------- | ------------------------------------------------------------------------------ |
| 37            | evaluation persists diagnostics while native state still exists                |
| 214           | CLI retains marketplace failure diagnostics without a native session           |
| 267           | CLI retains an early app-server failure for the goal example                   |
| 297           | CLI retains an early exec failure for the guide example                        |
| 325           | CLI retains the original preparation error and cause without transcript opt-in |
| 354           | CLI retains request validation failures before native state allocation         |
| 387           | CLI bounds and redacts app-server output without losing its prefix             |
| 433           | CLI retains exec timeout termination and partial output                        |
| 470           | CLI retains subprocess evidence when exec output exceeds the event limit       |
| 509           | CLI retains Claude preparation failures with the same opt-in                   |
| 537           | CLI retains a failed Claude process without a final response                   |
| 575           | diagnostic persistence failure remains an internal runner failure              |
| 700           | semantic native host diagnostics are persisted before cleanup                  |
| 718           | advisory native host diagnostics are persisted before cleanup                  |
| 738           | CLI retains preflight subprocess diagnostics with a failing stage              |
| 769           | CLI distinguishes plugin installation from marketplace installation            |
| 801           | native diagnostic journals stay within the artifact budget across many plugins |
| 874           | CLI failure results expose the retained diagnostic artifact location           |
| 889           | native cleanup failure does not replace the original execution failure         |
| 923           | Claude diagnostics redact inherited opaque credentials                         |
| 953           | CLI records an exec launch failure without inventing an exit code              |
| 989           | CLI identifies cleanup as the stage when a completed host cannot be cleaned    |
| 1025          | CLI distinguishes result processing failures from a successful exec process    |
| 1064          | CLI attributes an installed plugin manifest failure to hook preparation        |
| 1101          | CLI diagnostic stream caps remain byte-bounded at UTF-8 boundaries             |
| 1138          | CLI diagnostics redact a credential cut by the stream byte limit               |
| 1167          | secondary native diagnostic persistence failures stay internal: %s             |

## RH14: App-server settlement and feedback races

Source: [tests/hosts/app-server-settlement.test.ts](../../tests/hosts/app-server-settlement.test.ts).

Completion requires validated root history and terminal goal readback after queued events settle. Fatal errors, cleared/reactivated goals, unexpected root turns and later failed history invalidate settlement, emit failure and suppress a successful final result. A native turn racing readback must complete before final selection. Without client feedback the later native turn is final; with feedback the single declared correction becomes the second client turn and its completed response is final.

During feedback-boundary capture, fatal/cleared root events suppress the correction entirely: only one client turn, no follow-up marker and no leaked correction/credentials. A native turn starting during capture delays correction until that turn completes. Valid queued goal readback permits correction; invalid readback fails before sending it. Foreign-thread events cannot be used to settle or invalidate the root. Do not replace this with a fixed idle delay or settle based only on the last observed completion notification.

| Baseline line | Exact test declaration                                                         |
| ------------- | ------------------------------------------------------------------------------ |
| 33            | app-server refuses terminal readback races: %s                                 |
| 50            | app-server waits for a native turn racing readback; feedback=%s                |
| 196           | app-server withholds correction after root event during feedback capture: %s   |
| 226           | app-server defers correction for a native turn started during feedback capture |
| 256           | app-server wire validates queued goal readback during feedback capture: %s     |

## RH15: App-server wire and native goals

Source: [tests/hosts/app-server-transport.test.ts](../../tests/hosts/app-server-transport.test.ts).

Initialize, start one bound root thread and submit the declared turn(s), validating identifiers, effective root model/effort, correlated RPC responses and retained history. Malformed JSON/objects/messages, unmatched responses, RPC errors, unsupported server requests, premature exit, route mismatch, failed/fatal root turns, missing/foreign/duplicate history, missing items/final responses and invalid/disappeared/cleared goal data yield code 1 with a failure event, no final-turn claim and no last-message artifact. Goal status is a scalar enum: complete, paused, blocked, usageLimited and budgetLimited are valid nonactive statuses; array or invalid status/objective/thread data is refused. Goal objectives and private account/reasoning/commentary data stay out of public wire evidence.

Success retains the root final answer (`ready\n\ndone` in the fixture), completed turns, bounded command events, usage and native call labels. Failed individual commands remain failed even when the root completes successfully. Repeated unchanged goals deduplicate by state and source; notification and readback are distinct observations. The runner reads goal state without setting/clearing goals or interrupting a completed root. Exactly one declared feedback prompt produces two client turns, including when the native goal remains active; retain the real boundary goal status.

Retain at most 32 retry errors, a dropped count, retry classification, bounded 2,000-character redacted messages and optional HTTP/code details; malformed optional diagnostics remain unknown. Positive finite time bounds govern startup and turns; a stalled startup names its pending RPC, an unfinished turn without pending RPC does not invent one. Cancellation/deadline stops a silent peer; malformed unterminated trailing data still fails. Enforce stream and notification-queue limits independently. Drain large stderr while retaining its 16,000-character tail without contaminating event stdout. After validated completion close stdin, terminate an owned EOF-resistant peer and escalate when needed; no owned live process remains.

| Baseline line | Exact test declaration                                                                |
| ------------- | ------------------------------------------------------------------------------------- |
| 52            | app-server refuses %s at the host boundary                                            |
| 70            | app-server array goal status cannot establish terminal completion                     |
| 84            | app-server preserves valid nonactive native goal status: %s                           |
| 102           | app-server retains successful bounded evidence: %s                                    |
| 140           | app-server retry evidence is bounded, classified, and redacted                        |
| 157           | app-server wire retry diagnostics preserve unknown fields: %s                         |
| 178           | app-server wire failure at a pending boundary is retained: %s                         |
| 203           | app-server wire repeated goals retain one observation per unchanged state and source  |
| 218           | app-server wire a failed command remains distinct from successful root completion     |
| 234           | app-server wire final response decoder requires retained root turns                   |
| 253           | app-server wire foreign settlement events cannot invalidate a completed root          |
| 262           | app-server delivers exactly one declared feedback turn                                |
| 287           | app-server refuses invalid time bounds: %s                                            |
| 298           | app-server cancellation and deadline stop a silent real peer                          |
| 325           | app-server startup waits for the configured bound and names the stalled request       |
| 340           | app-server time bound during an unfinished turn names no pending request              |
| 350           | app-server transport failure from an absent executable cannot complete                |
| 359           | app-server closing transport still refuses an unterminated malformed trailing message |
| 368           | app-server oversized transport input is refused before becoming a result              |
| 377           | app-server drains oversized diagnostic stderr while retaining a valid root response   |
| 394           | app-server refuses a notification backlog within the transport byte bound             |
| 409           | app-server closes only its resistant owned peer after a validated result: %s          |
| 436           | app-server declared feedback can enter a thread while its native goal is active       |

## RH16: Claude authentication, route and plugin refusals

Source: [tests/hosts/claude-runtime-boundaries.test.ts](../../tests/hosts/claude-runtime-boundaries.test.ts).

Authentication order is explicit credential file, inherited API/OAuth credentials, saved login, then macOS Keychain when saved credentials are absent. Explicit file selection removes inherited API/OAuth from the launched host; copied credentials are mode 0600. Saved config contributes only credentials, never user rules/settings. Host credentials do not reach candidate commands, and the command-scrubbing indicator stays enabled. Selected malformed/empty/missing/oversized credentials, unreadable saved state, oversized environment credentials and failed/empty/oversized/timed-out Keychain lookup fail before model execution; timeout must kill the lookup child. Clean all staged secrets afterward.

Persisted valid root goals report complete, active, blocked or cleared status and objective character count (23 in the fixture) without objective text; malformed persisted goals remain unavailable even when the host turn succeeds. Validate absolute route/configuration/tool/cache/protected paths, nonempty model/effort and positive integral timeout up to 30 minutes. Reject unsupported enforcement/instrumentation, empty follow-up, fixture-bin escape and repository dispatch without project settings. Plugin manifests, roots and declarations must agree and stay inside the workspace; duplicate/undeclared/absent/escaping/overlapping plugins fail before launch. Explicit plugin invocation must match the declared prepared skill and syntax. Executables, legacy toolchain directories and UV caches may not overlap protected inputs.

| Baseline line | Exact test declaration                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------- |
| 120           | Claude explicit credential takes precedence over inherited authentication                       |
| 152           | Claude inherited %s credentials stay in the host environment                                    |
| 178           | Claude saved configuration contributes only credentials to private state                        |
| 214           | Claude selected credential %s refuses execution without fallback                                |
| 237           | Claude unreadable saved configuration refuses authentication rather than querying another login |
| 251           | Claude refuses an oversized environment credential before model execution                       |
| 268           | Claude missing saved credentials use the synthetic keychain account=%s                          |
| 295           | Claude keychain %s cannot become authenticated success                                          |
| 326           | Claude retained native goal reports %s as %s without its objective                              |
| 348           | Claude malformed persisted native goal remains unavailable: %s                                  |
| 390           | Claude route refuses invalid configuration: %s                                                  |
| 401           | Claude route refuses undeclared execution change: %s                                            |
| 538           | Claude refuses an unsafe declared plugin: %s                                                    |
| 563           | Claude verifies a declared plugin invocation before the real host process                       |
| 575           | Claude explicit dispatch refuses %s invocation                                                  |
| 622           | Claude refuses protected %s execution assets                                                    |

## RH17: Native-session metadata bounds

Source: [tests/hosts/native-output-recovery.test.ts](../../tests/hosts/native-output-recovery.test.ts).

Reject empty, whitespace-containing or overlong root identifiers as partial empty evidence. An unreadable owned home or sessions tree remains partial. Accept 1,024 traversed files and fail closed beyond that bound. Malformed JSON, nonobject records, unordered/fractional ordinals, missing/nonobject payloads and empty sessions cannot establish accepted spawns, feedback or absence. Call retention stops at 128 with partial completeness; more than 10,000 native entries also remains partial. Private tool arguments are omitted.

| Baseline line | Exact test declaration                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| 29            | native wire an invalid thread identifier cannot establish a session: %s                   |
| 39            | native wire unreadable owned %s leaves session evidence partial                           |
| 55            | native wire session traversal accepts its declared file bound and refuses excess metadata |
| 69            | native session malformed boundary remains partial: %s                                     |
| 94            | native retained call and entry limits stay explicit and cannot prove absence              |

## RH18: Native subprocess admission and stream bounds

Source: [tests/hosts/native-process-boundaries.test.ts](../../tests/hosts/native-process-boundaries.test.ts).

A request cancelled before admission must launch no child for either host. Both hosts accept stdout exactly at 8 MiB and reject overflow, terminating the owned process. Claude stderr accepts exactly 64 KiB and refuses overflow. Codex stderr instead drains excess bytes and retains the raw 64-KiB prefix with truncation; a prefix cut within a UTF-8 sequence is preserved as bytes at this low-level seam (later public diagnostics must re-bound decoded UTF-8). Completed or overflowed runs leave no live owned process.

| Baseline line | Exact test declaration                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| 27            | Codex drains stderr while retaining a raw prefix cut inside a UTF-8 sequence |
| 70            | native process pre-aborted %s request refuses child admission                |
| 85            | native process %s %s byte boundary %s; overflow=%s                           |

## RH19: Linux outer isolation

Source: [tests/linux-sandbox.test.ts](../../tests/linux-sandbox.test.ts).

With bubblewrap available, an isolated command can read a bounded public support directory and write its private runtime and fixture. It cannot read protected source/peer secrets or write read-only support; the original protected source is unchanged. Private sandbox state inside the fixture is refused. This is a real process/filesystem oracle and must run on Ubuntu with working unprivileged namespaces; a skipped probe is not Linux parity evidence.

| Baseline line | Exact test declaration                                            |
| ------------- | ----------------------------------------------------------------- |
| 10            | Linux isolation masks protected files and preserves owned runtime |
| 52            | Linux isolation refuses private state inside the workspace        |

## RH20: Outer sandbox validation and native hook grants

Source: [tests/mac-sandbox.test.ts](../../tests/mac-sandbox.test.ts).

Validate sandbox argv/path/protected-root inputs before accessing declared files. Require absolute available explicit protected roots and disjoint fixture/private state. Preserve protection of existing source checkouts when a registered linked worktree has vanished; ordinary invalid Git metadata is an error, not permission to stop protecting repositories. A previously verified peer remains denied after removal, through the explicit missing-root handling.

Native plugin read exceptions require the canonical curated layout bound to the current request and owned private state with safe permissions. Foreign request roots, projection/private aliases, wrong layout, public permissions, files instead of directories and overlap with ordinary policy grants are refused. The allowed projection is readable and read-only while authentication, private siblings and peer projections remain denied. The real outer sandbox allows fixture access and refuses protected reads/writes; malformed profile paths and empty protection sets fail. Network remains denied when selected by the isolation route.

| Baseline line | Exact test declaration                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------ |
| 68            | sandbox refuses a curated plugin grant from another native request                               |
| 109           | sandbox refuses an invalid native plugin grant: $kind                                            |
| 181           | sandbox grants only the current native plugin subtree read-only                                  |
| 231           | sandbox command refuses $label before accessing any declared path                                |
| 247           | sandbox private state must stay outside an otherwise disjoint workspace                          |
| 272           | evaluation isolation refuses a %s explicitly declared protected root                             |
| 299           | protection retains an existing checkout when a registered linked worktree has been removed       |
| 326           | protection refuses ordinary invalid repository metadata rather than treating it as no repository |
| 340           | profile denies reads and writes of each protected root                                           |
| 350           | outer sandbox permits the fixture but denies protected source                                    |
| 399           | workspace cannot overlap a protected root                                                        |
| 415           | a verified peer path remains denied after its fixture is removed                                 |

## RH21: Portable native-control observations

Source: [tests/native-controls.test.ts](../../tests/native-controls.test.ts).

The portable observation retains native tool labels and order without arguments, results, prompts or private targets. Claude preserves every tool label, including unrelated Read and native goal/Agent calls; accepted-agent and submitted-exec counts stay null because that seam does not establish them. A complete empty successful Claude stream can establish absence; malformed/failed/overfull streams remain partial with at most 128 calls and explicit truncation.

Codex projects only bound native labels and independently supported accepted-agent/submitted-exec counts. Unsupported/incomplete Code Mode receipts make the portable projection partial and counts unknown even if a raw session itself was complete. Preserve upstream unavailable/partial state. Contradictory receipt ordinals or submitted-code counts cannot become complete evidence.

| Baseline line | Exact test declaration                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| 16            | Claude retains all native call labels without arguments or results            |
| 61            | Claude malformed and truncated native control evidence remains partial        |
| 82            | Codex projects bound labels and explicit acceptance and submitted-code counts |
| 126           | Codex cannot project contradictory Code Mode receipt ordinals or counts       |

## RH22: Runtime configuration and CLI application

Source: [tests/runtime-cli.test.ts](../../tests/runtime-cli.test.ts).

Read exactly the selected runtime file before execution, including dry runs; explicit selection replaces the repository file. Reject malformed JSON/bytes, wrong format, unknown fields, symlink/nonregular/over-64-KiB files and absent explicit files with exit 64, `not_run` and no misleading trial evidence. Preserve useful bounded filesystem operation/path/OS-cause diagnostics. The legacy toolchain option still works with its warning alone; combining it with selected runtime configuration fails.

Snapshot declared existing non-secret environment values and explicit overrides into evidence. Runner/credential variables (including case-insensitive TMPPREFIX), NUL/oversized values, undeclared interpolation and malformed PATH entries fail before execution and do not leak values. Shell checks and both native candidates retain caller LANG, defaulting to `C` when absent. Inherited PATH filters credential directories, lexical/canonical tool aliases, absent credential paths and installation prefixes containing credentials, preserving safe order. Explicit PATH remains authoritative and rejects overlaps; no remaining safe entry is an error. Missing ordinary PATH entries and inaccessible individual aliases are inert, whereas unreadable directories, cyclic aliases and overfull directories are errors.

Grant only bounded read-only tool/support roots and their validated canonical targets; tools may read support and execute but cannot mutate it. Required roots must exist; optional roots may be absent only after lexical/canonical protection checks, including absent/dangling aliases. Whole-home/source/evaluator/credential/native-state overlaps fail before provider execution or seed hashing. No undeclared provider may be queried from protected source. Runtime identity binds selected HTTP/transcript/goal policy, effective environment/roots, skipped optional paths and seed contents including empty directories; per-run paths are not identity.

Seeds materialize verified executable bytes, internal links and empty directories in private writable copies. Original host caches stay unchanged; candidate/check/hook state cannot poison one another or be replaced by fixture-planted paths. Reject duplicate/reserved/overlapping targets, invalid/empty/duplicate role selections, cycles, escapes, special files, over-512-MiB trees, excess entries and unreadable selected input without fallback. Native goals select Codex app-server by default and enable Claude's declared goal path. macOS libc probes independently establish canonicalization of read/runtime/artifact grants with exact ancestor metadata visibility while parent listings/content, sibling metadata and writes remain denied.

| Baseline line | Exact test declaration                                                                        |
| ------------- | --------------------------------------------------------------------------------------------- |
| 22            | CLI snapshots local HTTP opt-in and binds evaluation identity                                 |
| 48            | CLI refuses lexical native seed aliases before hashing public targets                         |
| 77            | CLI refuses runner native state as public seed input: %s                                      |
| 115           | CLI snapshots explicit native transcript opt-in and binds identity                            |
| 273           | macOS read grants permit libc canonicalization with bounded ancestor visibility               |
| 371           | macOS private writable runtimes permit libc canonicalization with bounded ancestor visibility |
| 474           | macOS artifact grants permit libc canonicalization with bounded ancestor visibility           |
| 588           | CLI isolated shell locale uses the caller default when LANG is $name                          |
| 638           | CLI ${route} candidate locale uses the caller default when LANG is $name                      |
| 673           | CLI rejects malformed repository runtime configuration before execution                       |
| 682           | CLI reports operation and path for an unreadable selected PATH directory                      |
| 711           | CLI reports operation and path when an explicit runtime file is inaccessible                  |
| 739           | CLI accepts inherited macOS PATH with an inaccessible individual tool alias                   |
| 758           | CLI warns when using deprecated toolchain options                                             |
| 772           | CLI refuses invalid runtime input: $name                                                      |
| 870           | CLI refuses a missing explicit runtime file                                                   |
| 883           | CLI ignores missing PATH entries and broken tool links                                        |
| 900           | CLI rejects overlapping seed targets                                                          |
| 919           | CLI rejects cyclic seed directories                                                           |
| 934           | CLI refuses a seed over the documented byte bound                                             |
| 951           | CLI refuses special files in a runtime seed                                                   |
| 971           | CLI refuses an overfull PATH directory                                                        |
| 987           | CLI refuses mixing selected runtime configuration with legacy toolchain options               |
| 1005          | CLI protects grader runtime seeds from candidate-created state                                |
| 1036          | CLI native-goal policy selects Codex app-server by default                                    |
| 1079          | CLI snapshots declared repository environment in run evidence                                 |
| 1099          | CLI identity binds empty seed directories                                                     |
| 1124          | CLI explicit runtime file replaces repository configuration                                   |
| 1147          | CLI refuses credential or runner environment inheritance: %s                                  |
| 1177          | CLI inherited PATH executes read-only host tools in isolated checks                           |
| 1211          | CLI passes declared environment to a Claude candidate                                         |
| 1258          | CLI requires a bounded regular runtime file: %s                                               |
| 1278          | CLI applies explicit non-secret environment values to isolated checks                         |
| 1305          | CLI inherited tools can read their installation support files                                 |
| 1336          | CLI inherited PATH resolves symlinked tool installations                                      |
| 1367          | CLI inherited PATH omits Codex credential directories before the first evaluation             |
| 1412          | CLI inherited PATH omits credential aliases: %s                                               |
| 1451          | CLI inherited PATH omits an installation prefix containing credentials                        |
| 1487          | CLI inherited PATH refuses malformed entries before execution: %s                             |
| 1507          | CLI refuses a missing inherited PATH before execution                                         |
| 1524          | CLI refuses an explicit PATH override into Codex credentials                                  |
| 1542          | CLI refuses an inherited PATH with only credential directories                                |
| 1560          | CLI refuses runtime access to protected source before candidate execution                     |
| 1574          | CLI protects both optional-root alias boundaries: %s                                          |
| 1597          | CLI never queries metadata providers inside protected source                                  |
| 1619          | CLI rejects whole-home PATH before querying a provider                                        |
| 1641          | CLI rejects absent optional roots across protected boundaries: %s                             |
| 1669          | CLI protects canonical credential directories through unrelated aliases: %s                   |
| 1693          | CLI resolves optional home paths without granting the whole home                              |
| 1715          | CLI rejects malformed runtime bytes before executing                                          |
| 1723          | CLI rejects unresolved credential protections under an unreadable home                        |
| 1748          | CLI identity binds actual optional grants and skipped evidence                                |
| 1780          | CLI applies declared read-only roots outside PATH                                             |
| 1811          | CLI seeds a private writable runtime without changing the host cache                          |
| 1840          | CLI refuses runtime seed links escaping their declared directory                              |
| 1859          | CLI separates candidate and check runtime seeds                                               |
| 1919          | CLI enables declared native goals in the Claude runtime policy                                |
| 1960          | CLI never falls back after a selected runtime seed is unreadable                              |
| 1977          | CLI limits dependency seed slots to selected execution roles                                  |
| 2011          | CLI refuses invalid seed role selection $roles                                                |
| 2029          | CLI materializes verified executable bytes, internal links, and empty directories             |

## RH23: Bounded tool installation discovery

Source: [tests/runtime-discovery.test.ts](../../tests/runtime-discovery.test.ts).

Only declared PATH triggers provider discovery. Keep lexical lookup and canonical targets for valid aliases; inaccessible individual tool aliases are inert but unreadable optional roots and cyclic aliases are errors. Optional absence never bypasses protected lexical/canonical/native namespace boundaries. Failures retain OS causes and sanitize/truncate displayed path to 256 characters.

Homebrew metadata supplies only bounded Cellar/opt/etc support, never the whole prefix or a prefix ancestor; a separate bounded Cellar is supported. Nonexecutable providers contribute no discovery. A provider must return one absolute path within an 8-KiB combined output and three-second time bound. Nonzero exits, spawn failures, malformed/oversized output and timeout fail before execution with provider/operation diagnostics, without arbitrary provider output.

On macOS selected Apple Git/Python/compiler shims and their aliases discover developer support through the selected xcode-select. Only explicitly declared DEVELOPER_DIR participates. A known missing installation is inert only without an explicit conflicting selection; missing declared override remains an error. Unselected shims do not import metadata, and Linux never executes available Apple metadata shims. Deeply snapshot/freeze discovered provider evidence and skipped roots so caller mutations cannot change the evaluation.

| Baseline line | Exact test declaration                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| 17            | portable runtime declarations retain lexical native namespace protection: %s |
| 79            | optional runtime roots skip absent directories                               |
| 89            | missing optional roots preserve protected boundaries: %s                     |
| 122           | runtime roots preserve lexical symlink lookup and canonical targets          |
| 135           | PATH ignores inaccessible symlink tools while resolving readable aliases     |
| 167           | runtime filesystem diagnostics bound paths and retain their cause            |
| 186           | declared PATH discovers bounded Homebrew support from metadata               |
| 211           | declared PATH discovers selected Apple developer tools                       |
| 237           | runtime snapshot freezes discovery evidence and skipped roots                |
| 289           | Apple metadata sees declared developer selection                             |
| 315           | unreadable optional runtime directories remain errors                        |
| 337           | missing Apple developer installation is inert                                |
| 361           | unselected Apple tool shims do not import developer metadata                 |
| 388           | declared compiler shim discovers selected developer support                  |
| 415           | Apple metadata follows selected executable aliases: %s                       |
| 481           | detected provider failures stop with bounded diagnostics                     |
| 490           | metadata providers reject non-path output: %s                                |
| 500           | a non-executable provider file contributes no installation grants            |
| 508           | cyclic tool aliases fail instead of becoming absent providers                |
| 523           | Homebrew metadata cannot grant its whole installation prefix                 |
| 533           | Homebrew support cannot grant a prefix ancestor: %s                          |
| 552           | Homebrew supports a bounded independent Cellar                               |
| 567           | metadata spawn failures retain their operating system cause                  |
| 589           | metadata provider output is bounded                                          |
| 594           | metadata provider time is bounded                                            |
| 601           | invalid optional roots remain errors: %s                                     |
| 615           | undeclared ambient PATH cannot discover providers                            |
| 622           | optional cyclic aliases remain errors instead of absent roots                |
| 631           | Homebrew exit two is fatal even with an Apple absence diagnostic             |
| 640           | declared Apple selection cannot be skipped by an absence diagnostic          |
| 666           | Linux never queries an available Apple metadata provider                     |
| 692           | missing declared developer override stays an error                           |

## RH24: Authorized native plugin command hooks

Source: [tests/runtime-hooks.test.ts](../../tests/runtime-hooks.test.ts).

Only explicitly selected prepared plugins execute command handlers; unselected handlers are filtered. Real Claude native initialization and Codex exec/app-server routes must produce the selected hook's output while denied hooks stay absent. Curated projections live outside fixtures, remain read-only and protect original/canonical source, credentials, current and future peer workspaces/native state. Hook execution receives credential-free, network-denied private runtime state; fixture-planted caches do not replace verified hook seed bytes. Timeouts terminate asynchronous owned hook descendants before return and cleanup removes projections.

Support default hook files, host manifest references (including a shared file), native Codex declarations and skill/agent Markdown frontmatter while preserving ordinary Markdown. Reject unsupported prompt/agent/MCP handlers, missing/null commands, exec-form args even when empty, overlong/NUL command text, malformed groups/handler arrays, missing/duplicate plugin identities, mods, unavailable selected plugins and auxiliary MCP/LSP execution. These refusals occur before selected handler side effects. Retain source/effective plugin identity and observed executions without private wrapper filenames; empty execution evidence is not activation.

| Baseline line | Exact test declaration                                                      |
| ------------- | --------------------------------------------------------------------------- |
| 125           | Claude executes only selected plugin hooks under protected-root isolation   |
| 168           | Claude releases an asynchronous hook before returning the trial             |
| 222           | Claude protects hook runtime seeds from workspace-created state             |
| 273           | Claude refuses an unsupported selected hook: $name                          |
| 356           | Claude refuses malformed selected hook groups: $name                        |
| 406           | Claude refuses unsupported runtime plugin metadata: $name                   |
| 456           | Claude refuses an unavailable hook plugin selection                         |
| 483           | Claude refuses auxiliary plugin execution outside hook authority            |
| 518           | Claude executes a manifest hook file shared by both host manifests          |
| 588           | Claude safely processes skill hook frontmatter alongside ordinary Markdown  |
| 716           | Codex executes only selected plugin hooks under protected-root isolation    |
| 735           | Codex managed plugin hooks keep projections read-only and peers private: %s |
| 826           | Codex isolates hooks declared in its native plugin manifest                 |
| 859           | Codex app-server dispatches selected plugin hooks                           |

## RH25: Authenticated native integration probes

Source: [tests/runtime-live.test.ts](../../tests/runtime-live.test.ts).

These are explicitly opt-in live probes: `SEVRO_LIVE_CLAUDE=1` and `SEVRO_LIVE_CODEX=1`. With real existing subscription authentication, Claude's native goal must complete and Codex app-server must complete its native goal and return exactly `ready`. Claude Read must inspect an explicitly allowed support file; Bash must copy the expected support text from bounded real-home support, and declared mise Node must write the same version observed outside the fixture. Preserve these probes and their runtime grants through the Rust port. They are not covered by a synthetic protocol fixture, profile text or ordinary skipped test report. This specification records expected behavior, not a claim they were executed during extraction.

| Baseline line | Exact test declaration                                                      |
| ------------- | --------------------------------------------------------------------------- |
| 23            | live Claude native goal completes with existing subscription authentication |
| 68            | live Codex native goal completes with existing subscription authentication  |
| 118           | live Claude Read can inspect a declared read-only runtime root              |
| 159           | live Claude can read declared runtime support under the real home           |
| 203           | live Claude can execute the existing mise Node installation                 |

## RH26: Candidate-home artifacts through grading

Source: [tests/runtime/candidate-artifacts.test.ts](../../tests/runtime/candidate-artifacts.test.ts).

Artifact opt-in declares at most 16 uniquely named, bounded relative candidate-home subdirectories. Validate lowercase names, 64-character name and 4,096-character path bounds; reject whole-home/absolute/dot/dotdot/empty components, backslashes/control characters, duplicates and excess declarations before execution/results. Allocate the candidate runtime outside the fixture before launch; graders receive original named read-only paths while retaining their own homes. Native Codex semantic/advisory and Claude semantic/shell grading must read actual candidate bytes with transcript and Codex-state opt-ins in every tested combination. Without opt-in no artifact grant exists.

Missing trees, linked ancestors/roots/descendants, hardlinks, FIFOs/special files and more than 16,384 entries including root produce grading error, exit 3 and `not_assessed`; missing evidence cannot pass. Graders cannot write/delete/rename/create in grants or read unrelated home/credentials/current or later peers. Forged runtime or artifact paths are refused unless bound to the active trial/request. Policy declarations are snapshotted; temporary absolute paths do not change identity.

Retain roots through all grading/advisory/evidence use, then remove them on success, candidate/grader failure, grader timeout, cancellation, post-host throw and persistence failure. Cleanup restores sufficient permissions even after candidate chmod makes directories/home unreadable. Concurrent trials get different roots and clean both. Artifact opt-in alone does not archive artifact bytes or retain the runtime with failed fixtures.

| Baseline line | Exact test declaration                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| 40            | runtime configuration declares named candidate-home artifact directories                                    |
| 55            | evaluation keeps candidate review artifacts readable through isolated grading                               |
| 114           | candidate artifact runtime cleanup covers %s                                                                |
| 182           | candidate artifact grants refuse unsafe or missing trees: %s                                                |
| 216           | runtime artifact declarations refuse unbounded paths: %j                                                    |
| 242           | native Codex grading reads candidate artifacts with transcripts $nativeTranscripts, Codex state $codexState |
| 350           | artifact grants remain absent without evaluator opt-in                                                      |
| 379           | candidate artifact runtime is removed when evidence persistence fails                                       |
| 405           | native hosts refuse a forged candidate %s path                                                              |
| 424           | Claude candidate artifacts survive through shell and semantic grading: transcripts %s                       |
| 533           | artifact directory declarations fail before execution: case $index                                          |
| 567           | candidate artifact tree entry limit fails grading without exposing the tree                                 |
| 576           | artifact grader cannot read native peer state created after launch                                          |
| 632           | candidate artifact declarations are snapshotted and temporary roots stay outside identity                   |
| 667           | concurrent trials retain and release independent candidate artifact runtimes                                |
| 708           | candidate artifact cleanup restores restrictive directory permissions after grading                         |
| 732           | candidate artifact cleanup restores unreadable home on %s                                                   |

## RH27: Bound native Codex configuration and skill state

Source: [tests/runtime/codex-state.test.ts](../../tests/runtime/codex-state.test.ts).

The independent `codexState` opt-in exposes actual private CODEX_HOME config and writable non-system user skills while denying authentication. A physical checkout `.codex` remains represented input, unchanged and untrusted; its configured value must not override the isolated host config. Initialize and retain actual native Codex skills, native agent-home skills, command agent-home skills and command Codex skills. The native Codex `.system` subtree remains read-only; similarly named directories elsewhere do not qualify for the system-skill exclusion.

Bind five reserved artifact names (`codex_config`, `codex_skills`, `agent_skills`, `command_agent_skills`, `command_codex_skills`) to their original candidate paths. Graders get read-only access, never substitute empty directories or their own homes. Absence checks require all four user-skill roots and ignore only the real native Codex system subtree; any created skill in the tested locations fails absence with exit 1. Missing, linked, hardlinked, redirected or directory-instead-of-config evidence fails grading with exit 3. Other hosts cannot fabricate native Codex state; command visibility does not authorize evaluator state sharing. Each retained native binding belongs to one request; reuse is refused. Cleanup covers success, candidate/grader/transport failure and cancellation.

| Baseline line | Exact test declaration                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| 21            | Codex state opt-in exposes actual configuration without credential access     |
| 40            | Codex state opt-in keeps checkout configuration inert                         |
| 66            | Codex state grading observes actual user-skill creation with read-only grants |
| 99            | Codex state grading observes agent-home skill creation                        |
| 131           | runtime configuration opts into candidate-bound Codex state                   |
| 144           | Codex state artifact names cannot be rebound: %s                              |
| 166           | Codex state grading observes command-home skill creation                      |
| 205           | Codex state keeps bundled system skills read-only                             |
| 218           | Codex state absence grading detects %s user-skill state                       |
| 267           | Codex state cleanup covers %s                                                 |
| 319           | Codex state grading refuses %s evidence                                       |
| 363           | Codex state cannot be fabricated by a host without native evidence            |
| 378           | Codex state command visibility does not enable evaluator state sharing        |
| 424           | Codex state evidence stays bound to each native request                       |

## RH28: Role environments and temporary storage

Source: [tests/runtime/environment.test.ts](../../tests/runtime/environment.test.ts).

Both hosts honor the selected environment and keep fixture binaries ahead of declared PATH. Codex command children and continuation turns inherit the same private role runtime so state survives within the request, then disappears at cleanup; the runtime is outside the fixture. Reject credential/injection/runner-owned environment variables in direct programmatic requests as well as CLI files. On macOS, zsh here-documents and Python temporary files use private TMPDIR/TMPPREFIX both with and without runtime policy as tested, while shared host temporary files remain unreadable/unwritable. Retain complete `sevro.host.runtime` evidence with candidate role and applied environment names.

| Baseline line | Exact test declaration                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| 20            | Claude fixture binaries keep precedence with a declared PATH                  |
| 64            | Codex candidate commands use the declared runtime environment                 |
| 86            | Codex zsh here-documents use private temporary storage with runtime policy %s |
| 157           | Codex runtime survives continuation and inherited command children            |
| 178           | Codex rejects runner-owned environment values in direct runtime requests: %s  |
| 197           | Codex declared PATH preserves fixture tool access                             |
| 223           | evaluation retains complete native runtime policy evidence                    |

## RH29: Runtime policy derivation for graders

Source: [tests/runtime/grading-policy.test.ts](../../tests/runtime/grading-policy.test.ts).

Snapshot runtime values before invoking any adapter so mutation of the caller's policy cannot change subsequent grading. Semantic and advisory hosts receive the declared tool environment, but candidate hook authority is not implied. Response-only semantic grading omits default dependency seeds; explicitly semantic-selected seeds and artifact semantic grading retain their intended seeds. Omitted seeds still contribute original-source denial roots. Reject credential-bearing programmatic policies before creating result storage. A Codex exec host refuses native-goal policy and requires app-server; selecting a policy is not proof of a completed goal.

| Baseline line | Exact test declaration                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| 21            | evaluation applies the selected runtime policy to semantic and advisory hosts |
| 113           | response-only semantic grading omits implicit dependency seeds                |
| 177           | response-only semantic grading preserves original seed source denial          |
| 243           | response-only semantic grading retains explicitly selected semantic seeds     |
| 317           | evaluation refuses credential-bearing runtime policy before creating results  |
| 355           | Codex refuses native-goal runtime policy on the exec route                    |
| 372           | evaluation snapshots runtime values before a caller changes them              |
| 438           | artifact semantic grading keeps implicit dependency seeds                     |

## RH30: Native role and filesystem separation

Source: [tests/runtime/isolation.test.ts](../../tests/runtime/isolation.test.ts).

Codex's Linux empty-root permissions keep only required trusted native helper/session/projection trees and fixture content visible. Home inside a broad system baseline remains protected; safe preflight refusal is acceptable for an overlapping unsupported setup, exposure is not. Native commands can commit, change refs/index/objects, publish to a fixture-local remote and update fixture admission locks while source/results remain unchanged. A link from writable Git metadata into protected source cannot be followed for writes. Bounded support-tree aliases support reads and refuse writes; selected Apple Git can query its native configuration.

Private native namespaces deny current and later-created peer state with and without transcript opt-in. Direct policy must reject lexical native aliases even when their targets are public and canonical aliases into private state before copying seeds. For candidate, semantic and advisory roles with both transcript settings, plugin review files in external private HOME are usable during execution and removed afterward. Claude supports the same private review state using narrow grants rather than exposing its parent namespace.

| Baseline line | Exact test declaration                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| 42            | public Codex Linux profile keeps trusted native trees visible under an empty root                                  |
| 137           | Codex candidate can commit, publish local refs and update admission state                                          |
| 200           | Codex Git metadata grant cannot write through a link into protected source                                         |
| 228           | Codex runtime cannot read or write another native trial tree: transcripts %s                                       |
| 255           | direct runtime policy refuses lexical native seed aliases to public caches                                         |
| 290           | direct runtime policy cannot copy a symlinked private native seed                                                  |
| 322           | running native commands cannot read or write a later-created peer tree: transcripts %s                             |
| 358           | Codex resolved support-tree aliases grant reads and refuse writes                                                  |
| 414           | Codex retains protected home denial inside platform read baselines                                                 |
| 463           | Codex selected Apple Git can query configuration                                                                   |
| 494           | Codex runtime supports plugin review artifacts outside the repository: $role, transcripts $nativeTranscripts       |
| 525           | Claude runtime supports plugin review artifacts with narrow external grants: $role, transcripts $nativeTranscripts |

## RH31: Namespace placement and failure cleanup

Source: [tests/runtime/namespace-isolation.test.ts](../../tests/runtime/namespace-isolation.test.ts).

Before native launch or mutation, reject fixtures inside the private native namespace and namespaces inside fixtures, checking lexical and canonical alias directions. Leave original Git entries, namespace entries and peer bytes unchanged. On macOS also reject Claude namespaces/managed workspaces within implicit /tmp/claude or /private/tmp/claude writable trees, including aliases and the no-runtime-policy route. Both Codex and Claude remove external runtime state after process failure, timeout and cancellation; private state cannot be stranded in or beside the fixture as a fallback.

| Baseline line | Exact test declaration                                                                |
| ------------- | ------------------------------------------------------------------------------------- |
| 37            | $native runtime refuses a fixture within the native namespace: alias $viaAlias        |
| 104           | $native runtime refuses a namespace within the fixture: alias $viaAlias               |
| 188           | Claude runtime refuses a namespace within implicit native temp writes: alias %s       |
| 246           | Claude managed workspace refuses implicit native temp writes without a runtime policy |
| 326           | $native removes external runtime after $ending                                        |

## RH32: Live native transcript access and capture

Source: [tests/runtime/native-transcript-capture.test.ts](../../tests/runtime/native-transcript-capture.test.ts).

Absent/false opt-in keeps Claude command home/temp writable through its normal isolation without transcript grants. With opt-in, commands discover their own full live native tree through runner-owned environment bindings and can read it while private settings/auth/siblings remain denied and transcript writes are refused. Capture actual native root and child JSONL plus Claude sidecars, preserving native session association. Missing session sources remain unavailable; unbound/missing original roots remain partial even if some files exist.

Preserve malformed/truncated root or child bytes with their exact base64 representation and SHA-256 digest, downgrading bundle/observation completeness rather than discarding forensic evidence or claiming complete execution from them. Failed native execution retains available partial native bytes. Unsafe namespace ownership/permissions, forged retained views and credential-bearing symlink sources are refused; linked secrets must never enter artifacts. Native byte/metadata/artifact bounds report explicit issues and partial completeness, keeping the bundle at or below 8 MiB. A successful model turn and complete transcript collection are independent facts.

| Baseline line | Exact test declaration                                                                   |
| ------------- | ---------------------------------------------------------------------------------------- |
| 35            | Claude disabled transcript policy keeps command home and temp outside private denial: %s |
| 82            | successful native capture retains malformed child evidence and downgrades tree: %s       |
| 138           | successful native capture preserves malformed root bytes without claiming complete: %j   |
| 202           | Claude opt-in supplies live transcript discovery without granting private settings       |
| 260           | Claude opt-in reports unavailable native transcript evidence after cleanup               |
| 297           | native capture leaves an unbound root session partial                                    |
| 334           | Claude native capture associates root and child files with their native session          |
| 385           | Claude opt-in preserves partial native transcripts on stream failure                     |
| 424           | Codex opt-in exposes live native transcripts read-only while protecting private siblings |
| 445           | Codex opt-in retains native bytes and marks missing sessions unavailable                 |
| 473           | native capture refuses to call a missing original session complete                       |
| 502           | native transcript metadata cannot overflow the existing artifact budget                  |
| 543           | Codex opt-in preserves partial native transcripts when native execution fails            |
| 578           | native host refuses an unsafe pre-existing transcript namespace                          |
| 605           | native host refuses a forged retained transcript view                                    |
| 624           | native capture marks the declared native byte limit partial                              |
| 662           | native capture refuses credential-bearing source links                                   |

## RH33: Verified retained native evidence consumers

Source: [tests/runtime/native-transcript-retention.test.ts](../../tests/runtime/native-transcript-retention.test.ts).

Validate retained bundle format, supported host, file records and byte digests before calling any grader. Unsupported format/host, nonarray/invalid records and tampered bytes fail before grading. Materialize a separate temporary read-only view containing index and original relative Codex/Claude paths; shell and semantic consumers read the same verified native bytes while their own native state stays separate. Keep stable artifact references in saved evidence after temporary views disappear. Cancellation arriving after host completion still records cancelled execution and retains already captured native transcript artifacts.

| Baseline line | Exact test declaration                                                                   |
| ------------- | ---------------------------------------------------------------------------------------- |
| 37            | evaluation refuses $label retained native evidence before grading                        |
| 107           | evaluation supplies verified Claude native bytes to a retained-evidence consumer         |
| 205           | evaluation exposes retained native evidence to isolated shell and semantic consumers     |
| 275           | evaluation retains native transcript artifacts when cancellation follows host completion |

## RH34: Local HTTP opt-in

Source: [tests/runtime/network.test.ts](../../tests/runtime/network.test.ts).

With localHttp enabled, Codex candidate commands run a real wildcard listener and loopback HTTP client while direct outbound TCP remains denied. Exercise both Codex-state settings, including visible config and denied auth when state is enabled. The exact fixture answer is `local-http-ok`. Semantic and advisory roles do not inherit this candidate permission and return `bind-denied`. Keep shell/check network parity from the shared runtime contract; no global network permission may replace the loopback selection.

| Baseline line | Exact test declaration                                                                        |
| ------------- | --------------------------------------------------------------------------------------------- |
| 18            | Codex candidate local HTTP opt-in runs a real server with outbound TCP denied, Codex state %s |
| 46            | Codex local HTTP selection leaves the %s role network disabled                                |

## RH35: Verified private seed bytes

Source: [tests/runtime/seeds.test.ts](../../tests/runtime/seeds.test.ts).

Materialize each selected seed into writable private role state; candidate changes do not alter the original source. Reject source mutation between configuration fingerprinting and first capture. Reuse verified captured bytes for later trials sharing the policy even if the operator changes the source afterward; later trial writes remain independent. Fixture-planted legacy runtime paths cannot intercept or replace the seed. Reserved/escaping targets are refused. Source caches are protected from direct reads as well as writes, including an otherwise declared Claude read root. A bounded explicitly declared native installation under real HOME remains executable without granting the whole home.

| Baseline line | Exact test declaration                                                             |
| ------------- | ---------------------------------------------------------------------------------- |
| 28            | Claude refuses direct read access to an original seed source                       |
| 66            | Codex candidate commands use private runtime seeds                                 |
| 93            | Codex refuses a seed changed after its configuration snapshot                      |
| 115           | Codex runtime seeds ignore repository-local state planted by the candidate         |
| 144           | Codex refuses reserved or escaping runtime seed target: %s                         |
| 166           | Codex can reuse a declared native installation under the real home                 |
| 202           | Codex reuses verified dependency bytes while keeping trials and source independent |

## RH36: Codex passive skill-body exposure evidence

Source: [tests/skill-hooks.test.ts](../../tests/skill-hooks.test.ts).

The passive collector compares returned tool content with snapshotted prepared skill bodies, independent of shell syntax. Match complete bodies inside supported nested responses; discard unrelated values and omit commands, responses and skill bodies from receipts. Unique matches yield qualified activations; identical bodies under multiple names remain ambiguous/partial. Exact pages use complete nonblank anchors and fragments of at least 32 string code units, tied to body digest and exact offsets; extend adjacent partial lines only where position is unique. Repeated/unanchored/short/ambiguous fragments cannot fill missing coverage. Nesting, anchor and comparison limits fail closed.

Complete collection requires correct session start/stop and paired pre/post identities. Missing collection, unfinished or duplicate calls, wrong session, failed host, invalid receipt tails, malformed inputs and oversized receipt files remain partial while retaining independently established positives. A complete empty catalog/session may prove scoped absence. Catalog roots/skill files must be canonical and safe; invalid plugin identities, redirected folders/files, unreadable or oversized documents and count/body budgets make discovery partial. Empty documents/unrelated entries are ignored without inventing skills.

Catalog bounds are 128 skills, 1 MiB per body and 8 MiB total. Public call retention respects both 128 calls and 24 KiB serialized bytes, with truncation. The hook executable appends mode-0600 private receipts and produces no tool output, including transport/malformed/overflow errors; a partial marker records failure and exhausted receipt storage stops growing. These receipts establish returned body exposure, not file provenance, execution of instructions or whether Code Mode later showed the text to a model.

| Baseline line | Exact test declaration                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------ |
| 39            | hook receipt parsing rejects invalid envelopes and incomplete tool identities                    |
| 71            | hook receipts match complete bodies in nested responses and discard unrelated values             |
| 104           | hook receipts separate unique matches from identical skill bodies                                |
| 151           | page receipts map nested fragments to exact body offsets without retaining output                |
| 180           | page matching extends an anchor into adjacent partial lines                                      |
| 192           | page receipts distinguish short, unanchored and repeated fragments                               |
| 208           | page receipt matching bounds repeated anchors: %j                                                |
| 218           | excessively nested hook responses cannot masquerade as complete evidence                         |
| 282           | passive hooks identify returned bodies without parsing commands or retaining private output      |
| 307           | missing collection and unfinished tools remain partial while preserving positive evidence        |
| 328           | an output without its paired pre-hook cannot establish complete collection                       |
| 342           | complete empty collection differs from a failed host or the wrong session                        |
| 357           | malformed hook inputs stay silent and mark evidence partial                                      |
| 367           | catalogs reject redirected mounts and skill files                                                |
| 384           | identical bodies belonging to different skills remain ambiguous                                  |
| 406           | oversized catalogs and skills report incomplete discovery                                        |
| 446           | invalid receipt tails preserve earlier positives while marking collection partial                |
| 502           | receipt files exceeding the collection budget cannot report complete evidence                    |
| 513           | duplicate tool identities make an otherwise finished lifecycle partial                           |
| 535           | retained activation calls respect both count and serialized byte limits                          |
| 560           | the observer can collect a complete empty catalog when no roots are configured                   |
| 577           | catalog discovery rejects invalid plugin identity before installing a namespace                  |
| 591           | catalog discovery skips empty documents and unrelated entries but flags redirected skill folders |
| 629           | the hook executable appends private receipts without producing tool output                       |
| 647           | hook transport errors and input or receipt limits remain silent and incomplete                   |
| 676           | the total catalog budget and unreadable documents preserve partial discovery                     |

## Completion evidence

For each slice, retain the failing test command/result, the implementation that
made it pass, the final passing command and the exact candidate commit. Full
port completion requires the original regression suite plus equivalent Rust
behavioral coverage, native isolation on macOS and Ubuntu, and every required
GitHub CI check green for the final published head. No run was executed merely
to extract this reference, and no test listing or prose requirement is a passing
test receipt. Authentication-dependent probes must be reported with their
actual executed/skipped state.
