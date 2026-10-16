# Rust port: protocol, results, reports, and identity parity

This reference records the observable compatibility requirements for the Rust
port's extension boundary and retained results. It was derived from the public
contracts and the test assertions at baseline `1400f3f`. Reading these tests is
specification evidence, not evidence that they have passed on the Rust port.
The [port specification](rust-port.md) owns overall delivery and the other
behavior areas. The existing v1 formats remain compatibility boundaries.

## Authority and acceptance method

Read this document together with [extension protocol v1](../extension-protocol-v1.md),
[results v1](../results-v1.md), [report v1](../report-v1.md),
[identity v1](../identity-v1.md), and the five [published schemas](../../schemas/).
The schema files define every field, alternative, required/optional distinction,
closed object, pattern, uniqueness rule, and bound. Preserving only the common
example documents is insufficient. Runtime checks additionally establish
correlation, cross-record equality, identity computation, evidence availability,
path containment, and content integrity.

Use actual Rust CLI invocations, fresh temporary directories, independent
retained JSON fixtures, and real extension subprocesses. Compare JSON values
and exact stable bytes where specified; do not derive the expected answer by
calling the implementation being tested. Temporary paths, run IDs, measured
durations, and timestamps may vary while their shapes and relationships remain
asserted. Historical fixtures without optional fields remain valid and unknown.
The inventory below names the original tests, including parameterized templates;
each template's full source data table is part of its acceptance requirement.

## Extension wire boundary

| ID  | Input or event                                                                                                                                        | Required observable result                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01 | One configured argv and one request                                                                                                                   | Spawn a fresh process for each call, without shell interpretation; write one UTF-8 JSON document to stdin and close it; wait for exactly one response and process exit. Discovery uses `sevro.discovery.v1`; subsequent methods use `sevro.extension.v1`. |
| P02 | Normal discovery response                                                                                                                             | Accept a schema-valid object with matching `protocol`, `id`, and `method`, and exactly one of `result` or `error`. Return the advertised extension identity and capabilities. Never accept an echoed request as a response.                               |
| P03 | Malformed JSON, invalid UTF-8, extra stdout, root null/array/primitive, array ID/result, wrong protocol/ID/method, nonzero exit, or stdout over 8 MiB | Reject as a protocol error. A valid-looking response cannot hide a process failure or correlation mismatch. Wrong method is rejected before accepting its error body.                                                                                     |
| P04 | Empty argv, invalid request, already aborted signal, timeout zero/negative/fractional/infinite, or request over 8 MiB                                 | Refuse before attempting the process. Timeout is a positive safe integer; the current default is 30,000 ms. Launch failure has transport context.                                                                                                         |
| P05 | Timeout or in-flight cancellation                                                                                                                     | Cancel the owned process group and reject with timeout/cancellation context. Diagnostics do not expose private extension stderr or private error messages.                                                                                                |
| P06 | Error `{code:"example.refusal",message:"private source contents"}`; stderr longer than 64 KiB                                                         | Surface `extension reported example.refusal`, omit the private message, drain stderr beyond its retained prefix, and do not block on a full pipe. Stderr is never a result.                                                                               |
| P07 | Supported required capability and unsupported optional capability                                                                                     | Negotiate only available capabilities from the union of engine and selected-host capabilities. Missing required capability and no compatible offered protocol both refuse. Discovery bootstrap is unchanged when future protocol strings are advertised.  |

P01–P07 are covered by `tests/extension-client.test.ts`,
`tests/extension-boundaries.test.ts`, and the envelope/schema suites listed
below. The limits are byte limits for transport and Unicode character limits
for schema strings; a Rust implementation must not confuse the two.

## Extension session and engine integration

| ID  | Input or event                                                                                                 | Required observable result                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P08 | Open a session and call resolve, prepare, evaluate                                                             | Every method is stateless and runs in its own process. Carry the configuration and prior namespaced extension data explicitly. The lifecycle fixture resolves `extension-case`, returns `example.extension` data with `marker:"prepared"`, and evaluates `example.extension.ready` citing `sevro.observation.final-message`.                                                                                                  |
| P09 | Declared source closure or command changes                                                                     | Include the executable and caller-declared unique absolute source paths; hash before/after discovery and before/after later calls. An unreadable source, source change during discovery, change before resolve, or change during a successful resolve refuses. Argv and redacted configuration affect configuration identity. Preserve the snapshotted configuration throughout the session.                                  |
| P10 | Duplicate resolved case IDs; foreign or duplicate result IDs                                                   | Refuse duplicate cases. Check and domain-outcome IDs must be unique together and belong below the negotiated extension ID. A check and domain outcome cannot share an ID.                                                                                                                                                                                                                                                     |
| P11 | Passing extension check/domain outcome                                                                         | Require nonempty evidence references; every reference must exist; every reference used by a passing result must be complete. Partial/unavailable observations and unavailable built-in checks cannot justify a pass. Retained artifact references count as complete evidence; unknown references fail even on nonpassing outcomes.                                                                                            |
| P12 | Additive extension grading                                                                                     | Preserve built-in checks and append declared extension checks, metrics, provenance, and evidence references. The lifecycle oracle is checks `[ready,example.extension.ready]`, active graders `[sevro.regex,example.extension]`, and metric `{id:"example.extension.score",value:1,unit:"ratio"}`.                                                                                                                            |
| P13 | Independent domain outcome fails                                                                               | Retain the domain outcome independently in CLI trial and evidence. The fixture's `example.extension.activation` fails while task verdict remains passed. Invalid outcome evidence makes grading error and task unassessed.                                                                                                                                                                                                    |
| P14 | Explicit built-in replacement                                                                                  | Remove only named built-ins from active graders and trial checks; retain `replacedDefaults` and extension replacements. Validate replaced check declarations, require a declared advertised extension check, and reject unknown/duplicate replacements. Replaced shell/semantic checks do not execute or require their usual isolation/host route. Replacement changes identity.                                              |
| P15 | Selected advertised task policy                                                                                | A recommendation may replace a failed check's task verdict only after completed execution, completed grading, and available required evidence. Retain the policy ID and recommendation. Missing recommendation gives grading error/exit 3; unavailable evidence gives exit 4; failed host gives exit 2. Unadvertised policies and unsolicited recommendations refuse.                                                         |
| P16 | Omitted declared extension check, invalid extension response, failed/cancelled host, or failed built-in grader | Missing check gives grading unavailable, task unassessed, exit 4. Extension grading error gives completed/error/not_assessed, exit 3 and `sevro.grader.error`, retaining prior built-in checks. Skip evaluate for host failure/cancellation or built-in grading error; a failed built-in assertion still allows evaluate.                                                                                                     |
| P17 | Required instrumentation                                                                                       | Requests must be negotiated and supported by the host. Reject unsupported requests before host execution. Execution-changing instrumentation is invalid in passive trials; observational instrumentation may run passively. Retain requested and applied IDs/configuration separately. Missing application or enforced-to-passive drift gives execution failed, task unassessed, exit 2 and `sevro.instrumentation.mismatch`. |
| P18 | Inline/source preparation artifact                                                                             | Verify decoded bytes, digest, declared source map/root, and fixture-relative path before execution. Persist the verified bytes and digest independently of workspace cleanup. Wrong digest refuses before the host; changed retained bytes cannot support successful completion. `executable:true` retains owner execute permission and the flag.                                                                             |
| P19 | `gitExclude:true` preparation artifact                                                                         | Require a Git fixture, exclude only the exact mounted artifact path, and retain the flag. A prepared skill yields clean Git status; editing `README.md` then yields exactly ` M README.md\n`. Preparation may not hide candidate edits.                                                                                                                                                                                       |
| P20 | Negotiated fixture setup                                                                                       | Run once in the built Git fixture before artifact mounts and host execution; use bounded argv, a two-minute limit, declared noncredential environment, symbolic project/workspace values, and discarded output. Retain only its configuration digest and include the declaration in fixture identity. Unnegotiated setup refuses; a setup-created symlink cannot redirect an artifact into an outside directory.              |

The setup and artifact oracles also require preexisting-file/non-directory and
symlink refusal, private retained evidence, source-map containment, and bounded
content from the linked protocol and fixture contracts. The port must preserve
the engine's ownership of fixture preparation, cancellation, persistence, and
cleanup; an extension cannot change those responsibilities.

## Packaged and repository skill preparation

| ID  | Declaration                               | Required observable result                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P21 | Codex marketplace                         | Require `sevro.codex.plugin-marketplace`, a valid artifact root, declared names/local manifests, and Git-excluded package artifacts. Deliver verified artifact paths to the host; the fixture delivers four artifacts and retains `{artifactRoot:"marketplace",marketplaceName:"sevro-probe",pluginNames:["probe"]}`. Declaration and bytes enter identity.                                                                                                      |
| P22 | Claude plugin directories                 | Require `sevro.claude.plugin-dirs`; roots are unique, nonoverlapping fixture paths with Git-excluded files and `.claude-plugin/plugin.json`. Reject unnegotiated, unsafe, missing-manifest, or nonexcluded packages. Deliver only verified paths and retain the declared roots.                                                                                                                                                                                  |
| P23 | Explicit Codex packaged skill             | Negotiate marketplace and explicit invocation; mount the declared skill; replace the invocation placeholder exactly once across the two prompts with `$probe:probe`. Deliver `{pluginName:"probe",skillName:"probe",token:"$probe:probe"}` and retain the declaration. The placeholder may occur in the continuation turn. Repetition or missing negotiation refuses.                                                                                            |
| P24 | Explicit Codex repository skill           | Negotiate `sevro.codex.repository-invocation`; mount exact Git-excluded `.agents/skills/probe/SKILL.md`; render `$probe`; deliver `scope:"repository"` without a marketplace. Retain the repository declaration separately. Repeated placeholder, missing/nonexcluded mount, missing host capability, and conflicting invocation declarations refuse.                                                                                                            |
| P25 | Explicit Claude packaged/repository skill | Packaged invocation renders `/probe:probe` with plugin/skill declaration. Repository invocation requires `sevro.claude.repository-invocation`, exact Git-excluded `.claude/skills/probe/SKILL.md`, and a single leading initial placeholder, yielding `/probe Return ready.` with repository scope and no plugin directory. Repeated/nonleading placeholder, missing/nonexcluded mount, absent negotiation/host capability, and conflicting declarations refuse. |

Both neutral `{{sevro.skill_invocation}}` and the older Codex
`{{sevro.codex.skill_invocation}}` spelling remain supported where documented.
Native dispatch receipts and activation observations remain distinct; host
acceptance is covered by the native-host portion of the port specification.

## Assessment, exits, and persistence

The three state axes are independent. A failed task is an assessment outcome;
host and grader failures describe whether that assessment could be performed.

| ID  | Input                                                                                                       | Required output                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Successful prompt with no criteria                                                                          | `completed / not_requested / not_assessed`, exit 0.                                                                                                                                                                              |
| R02 | Dry preparation                                                                                             | `not_run / not_requested / not_assessed`, exit 0; no host execution or grading, all requested trials retained as `executionMode:"dry"`, duration null, raw path null, and distinct identity from execution.                      |
| R03 | Completed host, all declared checks pass                                                                    | `completed / completed / passed`, exit 0.                                                                                                                                                                                        |
| R04 | Completed host, a completed check fails                                                                     | `completed / completed / failed`, exit 1. Preserve individual failed checks even if a selected task policy overrides the verdict.                                                                                                |
| R05 | Host fails or returns `executionFailed:true`                                                                | `failed / not_requested / not_assessed`, exit 2; a matching final message cannot rescue it. Retain bounded artifacts and prior completed trials; do not grade a failed execution.                                                |
| R06 | Required grader fails                                                                                       | Grading `error`, no passing task, exit 3; retain prior evidence.                                                                                                                                                                 |
| R07 | Missing declared check or required observation/artifact; partial/unavailable required observation           | Grading `unavailable`, no passing task, exit 4. Complete host observations and retained artifacts can satisfy their declared IDs. Reserved final-message ID collision and invalid artifact ID fail host validation.              |
| R08 | Invalid invocation; runner/persistence failure; SIGINT; SIGTERM                                             | Exit 64; 70; 130; 143 respectively. Interruption outranks internal failure, then host failure, grader error, unavailable evidence, failed assessment, success. Exact per-trial states remain in JSON.                            |
| R09 | Two assessed trials `[passed,failed]`                                                                       | Threshold 0.5 passes, threshold 1 fails. Any unassessed required trial makes the case unassessed regardless of threshold. Across cases, any failed case makes the run failed; otherwise any unassessed case makes it unassessed. |
| R10 | Empty/repeated declared check IDs, foreign/duplicate returned IDs, empty assessment list, invalid threshold | Refuse. Threshold must be finite and in `(0,1]`; zero, negative, above one, NaN, and infinities are invalid.                                                                                                                     |

For aggregation, execution exposes failed/cancelled/not-run states and grading
exposes error/unavailable states instead of averaging them away. Task failure
can coexist with an operational failure elsewhere in the run. A failed check
does not authorize converting unavailable evidence into a pass.

Each trial's duration is a nonnegative monotonic measurement around the
candidate call and validation; historical absence and dry execution are
unknown. Unknown token/cost fields are null and usage completeness is false,
never fabricated zeros. A complete measurement of zero remains zero.

Persist every completed trial atomically before cleaning its workspace. A
two-trial pass/fail run at threshold 0.5 retains both trial files, removes the
successful workspace, and retains the failed workspace. Host failure on trial
2 of 3 with one job stops before trial 3, retaining trial 1 and the failed
attempt. SIGTERM during trial 2 retains both entries, preserves trial 1's pass,
and finalizes the active checkpoint as interrupted. Failed trial persistence
retains the fixture, refuses success, and leaves diagnostic run state.

Equivalent live runs are refused before a second host starts. Separate
run-state roots hold active/checkpoint records without exposing them to shell
checks. Retained workspace observations name candidate and auxiliary paths.
Inactive verified failed workspaces expire after 24 hours; saved evidence is
untouched. Active, unreadable, malformed, missing, permissively readable,
symlinked, unknown-host, or otherwise unverifiable ownership must preserve the
workspace. Remove expired ownership records for already deleted workspaces;
concurrent expiry of the same workspace remains safe. These lifecycle cases
are traced to `tests/engine.test.ts` below; dedicated lifecycle suites are
covered in the overall port spec.

The CLI must emit one `sevro.cli-result.v1` document on JSON stdout and keep
progress/diagnostics on stderr. Its retained evidence's `result` equals the
emitted result. Human completion exposes the same separate states and domain
outcomes. Save `result.json` beside run evidence and atomically update latest
for retained successful, failed, and dry runs. Pre-run failure leaves latest
unchanged. A CLI/latest persistence error changes an otherwise successful
outcome to internal failure; an earlier nonzero outcome retains precedence
and its evidence reference.

## Report CLI and aggregation

The first useful Rust CLI slice is `sevro report`: it exercises actual files,
schema validation, result/evidence integrity, independent arithmetic, output
formatting, and exit behavior without needing a model host.

| ID  | Fixture or invocation                                                                                          | Independent expected result                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q01 | A retained graded run, prompt-only run, and dry run, each with one case                                        | `format:"sevro.report.v1"`; three input records and three rows, summary `{cases:3,passed:1,failed:0,notAssessed:2}`, pass rates `[1,null,null]`. Graded row is `basic-graded / passed / completed / completed`, candidate route `sevro.host.example / deterministic-example / none`; dry duration null.          |
| Q02 | Complete trial duration/tokens/cost are all zero                                                               | Preserve zeros; Markdown includes `100% \| 0.00s \| 0 / 0 \| $0.0000`. Incomplete usage, even with numeric zero fields, yields null token/cost totals and `unknown / unknown \| unknown`.                                                                                                                        |
| Q03 | Multiple trials per case                                                                                       | Sum known candidate durations. Sum each token/cost dimension only if every trial has complete usage and that dimension is present; otherwise that dimension is null. Pass rate is passed-trial count divided by all trials only when all completed execution and grading with assessed verdicts; otherwise null. |
| Q04 | Multiple input runs/cases                                                                                      | Preserve input order then case order, one row per input case. Do not combine equal case IDs across runs or silently match comparisons. Every row retains its run exit category, identity, requested/actual condition, exact candidate route and all candidate/semantic/advisory routes.                          |
| Q05 | Failed task and unavailable domain outcome                                                                     | Summary `{cases:1,passed:0,failed:1,notAssessed:0}`, task pass rate 0, domain record `{trial:1,id:"domain-check",status:"unavailable"}`. Render a separate domain table and the statement that domain outcomes are independent of task verdict.                                                                  |
| Q06 | Historical trial without duration or domain outcomes                                                           | Accept valid old evidence. Duration becomes null; missing domain outcomes produce an empty row list and no Markdown domain section. Preserve the historical task/execution/grading/exit values.                                                                                                                  |
| Q07 | Pre-run invalid invocation, exit 64, no cases or evidence                                                      | Keep one visible input record with `not_run / not_requested / not_assessed`, exit 64, case count 0; produce no case rows. Reporting succeeds without changing the input exit category.                                                                                                                           |
| Q08 | Empty input list, duplicate files, programmatic relative result path, missing/relative required evidence path  | Reject. Programmatic `createReport` paths must be absolute and distinct. CLI paths may be relative and are canonicalized before duplicate detection/loading. A nonzero pre-run failure with no cases is the exception permitting absent evidence.                                                                |
| Q09 | Wrong run ID, changed embedded result, missing/duplicate/wrong-number trial, missing/duplicate candidate route | Reject instead of displaying inconsistent evidence. Match each result case/trial to exactly one retained trial and require exactly one candidate route. Compare embedded result structurally through canonical JSON. Validate both public schemas before reporting.                                              |
| Q10 | Invalid report options, extra positional, unreadable result                                                    | CLI exit 64 with nonempty stderr. Valid report invocation exits 0 and emits Markdown by default or one JSON document with `--json`.                                                                                                                                                                              |
| Q11 | `--latest`, optional `--results-root`                                                                          | Select `<cwd>/.sevro/results/latest.json` by default. `--latest` is exclusive with `--result-file`; `--results-root` requires latest. Missing latest or evidence is an error.                                                                                                                                    |
| Q12 | Labels `case\|line` followed by newline and `next`, or missing route/condition/path                            | Escape literal pipes as `\|`, replace line breaks with spaces, show unknown measurements/routes/conditions explicitly and unavailable evidence as unavailable. Do not allow a label to create a table row.                                                                                                       |

Q01/Q02/Q05/Q06/Q07/Q09/Q10/Q12 are directly asserted in the report suites.
Q03/Q04 follow the report contract and inspected `src/report.ts`; retain explicit
multi-trial/multi-case Rust integration cases, rather than relying on the
single-trial legacy fixtures as proof. Q11's integration coverage is in the
CLI workflow suites referenced by the overall spec. Markdown additionally
preserves input-runs, case-outcomes, retained-evidence, optional domain-outcomes,
and routes sections; duration uses two decimal seconds, cost four decimals,
and task rate a whole percentage. These are descriptive reports, not evidence
of matched conditions or domain-specific benchmark interpretation.

## Canonical identity and provenance

| ID  | Input or mutation                  | Required result                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I01 | `{b:[2,{z:true,a:"é"}],a:1}`       | Canonical bytes are `{"a":1,"b":[2,{"a":"é","z":true}]}`. Object insertion order does not affect bytes or hash; array order does. Canonical JSON round-trips ordinary JSON and is idempotent.                                                                                                                                                                                                    |
| I02 | Identity dimensions                | Exactly `runnerBuildDigest`, `projectDigest`, `configurationDigest`, `extensionDigest`, `extensionProtocol`, `caseDigest`, `fixtureDigest`, `checksDigest`, `requiredEvidenceDigest`, `evaluatorDigest`, `graderDigest`, `instrumentationDigest`, `routeDigest`, `condition`, `trialCount`, and `passThreshold`. Every comparison-critical dimension changes the evaluation digest when changed. |
| I03 | Digest generation                  | SHA-256 of JCS UTF-8 for each structured component. Evaluation digest is SHA-256 of UTF-8 `sevro.identity.v1\n` followed by JCS dimensions. Return algorithm `sevro.identity.v1` and lowercase 64-hex digest.                                                                                                                                                                                    |
| I04 | Non-JSON/canonical input           | Reject nonfinite numbers, undefined values, lone high/low surrogates, cycles, nonplain objects, accessors, and symbol keys. Accept paired supplementary Unicode such as `😀` and preserve it. JCS object-key order is UTF-16 code-unit order, so ordinary Rust Unicode scalar sorting alone is insufficient.                                                                                     |
| I05 | Invalid dimensions                 | Reject null/array/scalar dimensions; missing/extra keys; uppercase/short digests; content/protocol mismatch; unsupported extension protocol; unknown condition; zero/fractional/unsafe trial count; zero or above-one threshold. Both extension dimensions are null together or a digest plus `sevro.extension.v1`.                                                                              |
| I06 | Package build                      | Hash sorted declared packaged paths and contents under `src`, `schemas`, `docs`, `examples`, plus `README.md` and `package.json`. Source/example changes alter digest; filesystem insertion order, unrelated files, and Git metadata do not.                                                                                                                                                     |
| I07 | Project provenance                 | Clean Git project has a revision and null dirty digest; tracked changes and then untracked content each alter dirty/project identity without changing revision. Without a revision, including unborn Git, provenance revision/dirty digest stay null and project identity uses a bounded content snapshot.                                                                                       |
| I08 | Project snapshot/storage           | Same bytes at relocated roots with different timestamps have the same identity; executable mode changes it. Exclude selected result/run-state storage from non-Git and untracked Git identity while retaining tracked changes. Writing results does not change repeated evaluation identity.                                                                                                     |
| I09 | Unsafe/oversized snapshot          | Package/non-Git snapshot refuses symlinks and nonfiles, including FIFO, without reading/replacing/mutating them; over 64 MiB refuses without changing ordinary source. Git tracked patch or untracked bytes over 32 MiB refuses without changing revision, status, or content.                                                                                                                   |
| I10 | Runner provenance                  | Default to exact installed package identity/version/build digest. Explicit checkout mode records matching Git checkout root, revision and dirty digest. Unrelated package roots and nested paths posing as the Git root refuse. Runner and evaluated-project provenance remain separate.                                                                                                         |
| I11 | Workspace continuation fingerprint | Hash visible file bytes, mode, and symlink target text; ignore `.git`. Changing an external symlink referent's bytes has no effect; changing link target does. Accept 10,000 entries and return null at 10,001; oversized content (129 MiB fixture, 128 MiB bound) gives unavailable/null identity.                                                                                              |

I06 records the existing TypeScript packaged-path identity profile. The
authorized native profile instead binds the actual installed Rust executable
and its separately shipped assets, as defined in
[native build identity](../identity-v1.md). Standalone builds currently embed
their runtime assets and have an empty external-asset list. A native npm bundle
must retain the existing mandatory packaged roots through an explicit bundle
profile and fail closed when its layout or required assets are missing. It
must not discover a source checkout or silently downgrade a bundle to standalone.
The profiles remain distinct; neither assigns new meaning to historical digests.

I04's Rust-specific sorting requirement follows the JCS contract and inspected
JavaScript canonicalizer. Preserve independent vectors at the Rust seam for
UTF-16 ordering, ECMAScript number serialization (including negative zero),
escaping, and rejection; legacy insertion-order tests alone do not prove full
JCS compatibility.

Configuration identity binds trial parallelism, sampling/threshold, execution
mode, routes, active/replaced graders, required evidence, instrumentation,
extension redacted configuration, declared host configuration, selected runtime
policy, and assessment-relevant resolved run settings. Keep secret-presence
markers instead of credential bytes. Optional resolved operational previews,
run IDs, temporary paths, output locations, raw diagnostics, and timestamps do
not enter comparison identity. Extension setup symbolic values, packaged
artifact digests, and explicit invocation declarations do. Do not invent
missing identity fields for historical evidence.

## Schema and property acceptance

Preserve the exact published schema meanings rather than translating schemas
into permissive Rust structs. The independent oracle is each schema's declared
constraint plus explicit expected acceptance/rejection fixtures. The existing
property suites use seed `20261007`, 200 runs, stopping at the first failure;
retain the failing seed and replay path in diagnostics.

| ID  | Boundary family                                        | Required acceptance/rejection                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | All populated extension/result/evidence/report records | Accept valid rich and minimal serialized documents; reject removal of every required field, every forbidden JSON type, undeclared fields in closed records, invalid enums/patterns, duplicate unique members, and violated bounds. Removing each optional field remains valid. Runtime and generated validators agree on baseline extension/result/evidence examples. |
| S02 | Extension envelopes                                    | Require protocol, nonempty correlation ID and method, and exactly one request/result/error alternative. Discovery protocol only for describe; extension protocol only for other methods. Reject primitive/array roots. Errors remain valid for each method but cannot coexist with params/result; error codes are namespaced and messages nonempty.                   |
| S03 | Extension declared bounds                              | ID/version max 128 characters; namespace keys max 128 (128 accepted, 129 refused); error/check-detail max 4096 Unicode characters (4097 refused). Empty check detail is accepted. Generated commits 0–128, each commit's files nonempty; hooks max 32; fixture executables max 64; setup argv 1–16.                                                                   |
| S04 | Extension content/evidence                             | Inline base64 and sourceRef are mutually exclusive and one is required. Namespaced opaque data keys remain namespaced at resolve, prepare request/result, evaluate. Opaque JSON values/configuration survive serialization. Passed extension checks require evidence; failed/unavailable may have none; built-in passed results may have empty evidence references.   |
| S05 | Capability/protocol and state variants                 | Discovery protocol lists are nonempty, unique, `sevro.extension.vN` with N positive; v1/v12 accepted, v0/bootstrap-as-extension refused. Preserve every execution/completeness/check/recommendation enum. Extension and evidence metrics permit null, zero, positive, and negative measurements.                                                                      |
| S06 | CLI/result/report numbers                              | Exit only 0/1/2/3/4/64/70/130/143; trial indices/counts positive integers; report summary counts nonnegative integers; pass rate null or `[0,1]`; durations/cost null or nonnegative numbers; tokens null or nonnegative integers; digests lowercase 64 hex where nonnull.                                                                                            |
| S07 | Passing task consistency                               | At run, case, and trial levels, passing requires execution completed and grading completed. Failed/cancelled/not-run execution and error/unavailable/not-requested grading cannot pass. `not_assessed` remains serializable for all supported state combinations; historical operational failure with task failed is not rewritten as passed.                         |
| S08 | Evidence nullable alternatives                         | Preserve null extension, policy, advisory record, dirty/extension/raw digests where declared; preserve optional absent diagnostics, durations, and domain data. Nullable objects still reject extra fields and wrong nested types. Raw artifact paths are null or absolute `file:///` URLs, not HTTP URLs or relative file URLs.                                      |
| S09 | Evidence detailed values                               | Roles candidate/semantic/advisory; execution mode executed/dry/unknown; actual condition passive/enforced/unknown; observation completeness complete/partial/unavailable; selected policy recommendation passed/failed/not_assessed/null. IDs/version/summary/source cannot be empty when required; negotiated capabilities and replacements are unique.              |
| S10 | Advisory/native opaque evidence                        | Advisory status completed/failed/not_run, assessment verdict pass/fail, overall/dimension ratings integer 1–5, nonnegative/null usage. Preserve bounded native-control complete and partial receipts, opaque observation payloads, redacted host configuration and secret-presence markers without fabricating completeness.                                          |

All five schema documents remain authoritative. Runtime-policy-specific
semantics and the runtime schema's integration cases belong to the runtime
portion of the overall port specification; this inventory covers the dedicated
extension/result/report/run-evidence schema suites and shared properties.

## First vertical Rust slices

1. A real `report --json --result-file` process reads hand-authored graded,
   prompt-only, dry, and pre-run-failure fixtures. Assert exact schema version,
   row ordering, summary, null-versus-zero behavior, retained exit categories,
   and process stdout/stderr/exit. Start with the deliberately failing public
   invocation before implementation.
2. Add malformed/mismatched result/evidence rejection and schema boundary
   mutations; prove exit 64 and absence of a successful report. Then add
   Markdown escaping and latest/canonical-path selection.
3. Drive identity through retained results and reporting using independently
   computed JCS/hash vectors; keep JSON-only tests at the public serialization
   seam for Unicode and numeric edge cases.
4. Run the existing stateless extension fixture as an actual subprocess from
   Rust. Drive describe/resolve/prepare/evaluate success, refusal, timeout,
   cancellation, oversized/non-UTF-8 output, source mutation, and evidence rules.
5. Complete an end-to-end deterministic host run through prepared fixture,
   additive grading, trial persistence, cleanup/retention, report, and explicit
   failure controls. Reuse the same seam for each next integration feature.

These slices are implementation ordering, not permission to remove remaining
features or to report full migration after only the report command works.

## Test inventory

The following inventory records exact source test titles. Parameterized titles
are shown as source templates; all listed variant tables and loops remain in
scope. Shared fixtures and production sources are listed after the inventory.

### tests/extension-client.test.ts

[Source](../../tests/extension-client.test.ts).

- exchanges one validated message with a fresh extension process
- rejects malformed, oversized, and mismatched responses
- rejects ordinary JSON response with %s before returning a result
- prepare transport accepts a maximum-length data key and refuses an overlong key
- rejects a request envelope returned as an extension response
- stops a timed out extension and excludes its private stderr
- cancels an in-flight extension request
- negotiates required capabilities and ignores unsupported optional ones

### tests/extension-session.test.ts

[Source](../../tests/extension-session.test.ts).

- negotiates and runs resolve, prepare, and evaluate in separate processes
- refuses a changed extension source during the same session
- command arguments affect identity and passed checks need evidence

### tests/extension-boundaries.test.ts

[Source](../../tests/extension-boundaries.test.ts).

- reports the extension error code while keeping its private message out of diagnostics
- rejects non-UTF-8 process output with useful encoding context
- rejects a schema-valid response for another method before accepting its error
- refuses discovery when the extension offers only an incompatible protocol
- refuses invalid timeout ${timeoutMs} before trying to launch the extension
- refuses an empty command and an already-cancelled request before process launch
- refuses an oversized request before launching its process
- reports a launch failure with transport context
- drains diagnostic stderr beyond its retention bound while accepting one valid stdout response
- refuses a source change made by the extension during discovery
- refuses a source change made during resolve even after a valid response
- refuses duplicate resolved case IDs from a schema-valid extension
- refuses ${refusal.name} through the public extension session
- refuses an advertised selected policy when its recommendation is omitted
- refuses a task policy that was never advertised
- refuses passed extension results citing ${completeness} observations
- allows complete artifact evidence but refuses an unavailable built-in check as passing evidence
- refuses duplicate replacement declarations before extension launch
- refuses unreadable declared extension source without launching discovery

### tests/extension-engine.test.ts

[Source](../../tests/extension-engine.test.ts).

- extension checks add to built-ins and retain negotiated provenance
- domain outcomes remain separate from the task verdict
- explicit grader replacement removes only the selected built-in checks
- selected task policy may replace a failed check verdict and retains its decision
- extension grading receives complete host observations
- extension grading receives retained host artifacts
- extension grading error cannot become a passing task
- an omitted declared extension check leaves grading unavailable
- unsupported instrumentation stops before host execution
- negotiated instrumentation records host application and rejects condition drift
- prepared inline artifacts survive fixture cleanup with their digest
- negotiated fixture setup runs before artifacts and enters comparison identity
- fixture setup cannot redirect a preparation artifact outside the trial
- fixture setup refuses an extension without its negotiated capability
- prepared skill files stay outside Git status without hiding candidate edits
- negotiated Codex marketplace reaches the host and binds fixture identity
- Codex marketplace requires negotiation and a valid artifact root
- negotiated Claude plugin directory reaches the host and binds fixture identity
- Claude plugin directory rejects unnegotiated or unsafe packages
- explicit Codex invocation renders once and reaches the selected host
- explicit repository invocation preserves scope and retained identity
- explicit Codex invocation can occur in the continuation turn
- explicit Claude repository invocation renders a native project command
- explicit Claude invocation renders a packaged slash token
- prepared executable artifact runs from the fixture and retains its mode
- Git-excluded preparation artifacts require a Git fixture
- declared source artifacts are retained and mounted with verified bytes
- a wrong preparation digest fails before host execution
- a changed retained artifact cannot support a successful result

### tests/results.test.ts

[Source](../../tests/results.test.ts).

- trial assessment refuses a ${name} without accepting its passing checks
- trial assessment refuses ${name} in its declared criteria
- assessment summary refuses an empty trial set
- assessment summary refuses a threshold of ${name}
- prompt-only and dry runs do not claim task success
- failed checks are distinct from grading and execution failures
- missing evidence and grader errors cannot pass
- a case threshold applies only to fully assessed trials
- exit precedence preserves the most severe operational failure

### tests/report.test.ts

[Source](../../tests/report.test.ts).

- report keeps measured task outcomes separate from dry and prompt-only runs
- public report command emits versioned JSON and readable rows
- report rejects inconsistent evidence and keeps historical duration unknown
- report keeps a pre-run invocation failure visible without a case row

### tests/report-outcomes.test.ts

[Source](../../tests/report-outcomes.test.ts).

- reports refuse invalid input file sets: %j
- reports refuse %s retained evidence paths
- reports refuse inconsistent retained identities: %s
- reports preserve measured zero while incomplete usage remains unknown
- reports retain failed verdicts and independent domain outcomes
- reports accept historical trials without domain outcomes while preserving their independent task verdict
- report tables escape labels and render absent measurements explicitly
- public report CLI refuses invalid requests: %j

### tests/identity.test.ts

[Source](../../tests/identity.test.ts).

- canonical JSON is stable across object insertion order
- identity changes with each comparison-critical dimension
- identity rejects missing dimensions and non-JSON values
- identity refuses serialized comparison inputs with ${invalid.name}
- canonical identity JSON accepts paired supplementary Unicode and refuses a lone low surrogate

### tests/provenance.test.ts

[Source](../../tests/provenance.test.ts).

- ${route.name} refuses an owned FIFO without changing its inode or ordinary source files
- ${route.name} refuses symbolic source paths without following or replacing them
- ${route.name} refuses more than 64 MiB of ordinary source bytes without changing them
- Git project provenance refuses tracked patch output above 32 MiB without changing the checkout
- Git project provenance refuses untracked bytes above 32 MiB without changing the checkout
- project provenance stays unknown without a Git revision
- package build digest tracks packed runtime files without Git metadata
- project identity snapshots non-Git content but excludes result storage
- runner provenance uses package identity unless the running checkout is explicit
- project provenance distinguishes revision, tracked edits, and untracked files

### tests/workspace-fingerprint.test.ts

[Source](../../tests/workspace-fingerprint.test.ts).

- workspace identity hashes symlink targets without reading external contents
- workspace identity is unavailable when directory entries exceed its declared bound
- oversized workspace contents leave continuation identity unavailable
- workspace identity tracks visible content and mode but ignores Git state

### tests/schema.test.ts

[Source](../../tests/schema.test.ts).

- accepts discovery and each extension operation
- rejects ambiguous or incomplete extension messages
- keeps execution, grading, and task verdict distinct in CLI JSON
- requires separate runner, project, and extension provenance

### tests/schema-boundary-properties.test.ts

[Source](../../tests/schema-boundary-properties.test.ts).

- serialized result schemas enforce numeric bounds, integer counts, digest spelling and exit enums
- serialized state consistency refuses passed tasks after execution or grading failure
- real serialized results reject wrong JSON types at unconditional typed boundaries
- serialized contracts refuse undeclared fields, duplicate evidence, invalid choices and declared bounds
- serialized contracts retain meaning when declared optional diagnostics and evidence are absent
- real serialized results refuse lost required state at every populated schema boundary

### tests/extension-schema-properties.test.ts

[Source](../../tests/extension-schema-properties.test.ts).

- extension contracts refuse duplicate capabilities, undeclared fields and declared bounds
- extension callers can omit each declared optional configuration and evidence field
- extension v1 rich requests and responses retain required fields and typed boundaries
- extension responses preserve opaque JSON data but refuse ambiguous success and error
- each extension operation represents refusal without claiming a result
- passed extension checks require evidence and detail is bounded

### tests/schema/extension-boundaries.test.ts

[Source](../../tests/schema/extension-boundaries.test.ts).

- rich extension documents retain every required scalar and container
- rich extension documents enforce declared choices, patterns, uniqueness and closed fields
- optional extension fields may be absent without changing envelope kind
- extension envelopes require protocol, correlation ID and method at the file-format seam
- extension declaration cardinality boundary: %s
- %s request/result/error envelopes remain exclusive
- source and inline preparation content are mutually exclusive
- passed extension checks require evidence while failed or unavailable checks can have none
- extension namespaced data keys refuse ordinary unnamespaced application keys
- opaque extension data and configuration survive serialized JSON without claiming completeness
- discovery advertises compatible version lists without changing the bootstrap protocol
- extension refusal messages and opaque IDs use Unicode character length bounds
- extension metric values preserve unknown or signed measurements: %s
- evaluation requests preserve execution category %s
- evaluation observations preserve declared completeness %s
- built-in results preserve %s without imposing extension evidence policy
- extension recommendation represents %s independently of check statuses
- declared string length limits accept their exact maxima
- extension namespaced data restrictions apply at every operation boundary
- JSON extension envelopes refuse primitive and array roots
- %s bounds namespaced JSON data property names to 128 characters

### tests/schema/evidence-boundaries.test.ts

[Source](../../tests/schema/evidence-boundaries.test.ts).

- run-evidence files refuse every forbidden JSON type at populated published type boundaries
- run-evidence files preserve declared required, scalar, array and closed-object constraints in rich modes
- run-evidence files allow declared optional evidence to be absent
- run-evidence enforces ${boundary.name}
- run-evidence accepts published ${alternative.name} variants
- run-evidence preserves complete and unknown native-control receipts without tool arguments
- run-evidence permits redacted host configuration maps and secret-presence markers
- run-evidence allows completed ${assessment.name} assessments to pass
- run-evidence refuses a passed ${assessment.name} task with ${state.execution}/${state.grading}
- retained nullable records enforce %s
- retained %s refuses undeclared fields inside nullable alternatives
- retained nullable identities preserve explicitly unknown digests and absent policies

### tests/engine.test.ts

[Source](../../tests/engine.test.ts).

- runs trials, applies threshold, and retains evidence before fixture cleanup
- renders the workspace token separately for each trial
- routes a rendered continuation only to a capable host
- dry preparation records every trial without executing the host
- required host observations fail closed when missing or incomplete
- host artifacts are retained per trial and can satisfy required evidence
- semantic checks use an isolated grader route and retain verdict evidence
- advisory review inspects a blind change and cannot alter task grading
- host failure retains completed trials and reports execution failure
- engine refuses an equivalent live run before a second host starts
- cancellation retains prior trial evidence and finalizes interruption
- stores checkpoints apart from results and hides run state from shell checks
- failed trial persistence retains its fixture and never returns success
- rejects fixture paths that could escape their workspace
- shell checks grade fixture effects and retain exit observations
- shell failures and timeouts remain distinct from host completion
- engine retains a failed candidate workspace while preserving saved evidence
- engine retains the semantic workspace when grading fails
- engine retains the candidate workspace when required grading evidence is unavailable
- engine startup expires inactive failed workspaces after a day without deleting evidence
- engine startup preserves an active workspace older than a day
- engine startup removes expired ownership records after a workspace was deleted manually
- engine startup preserves a workspace with unreadable ownership metadata
- engine startup preserves expired workspaces with unverifiable ownership
- engine startup cleanup tolerates concurrent evaluations expiring the same workspace
- engine shell isolation hides a sibling created after sandbox launch
- engine shell isolation hides project sources and explicitly protected peer fixtures

### tests/cli/results.test.ts

[Source](../../tests/cli/results.test.ts).

- CLI emits one JSON result and uses the task exit category
- CLI reports unavailable required host evidence
- CLI runs semantic checks through an explicit grader route
- CLI selects an advisory route and retains its independent assessment

### tests/cli/identity.test.ts

[Source](../../tests/cli/identity.test.ts).

- CLI derives stable build and project digests without caller inputs
- CLI records an explicitly selected local runner checkout

### tests/fixtures/provenance.test.ts

[Source](../../tests/fixtures/provenance.test.ts).

- unborn Git repositories retain unknown project provenance rather than inventing a revision
- checkout provenance refuses a nested directory in place of the explicit Git root
- non-Git project identity ignores relocation and timestamps but distinguishes executable content
- package build identity uses declared runtime paths independent of filesystem insertion order and unrelated files

### tests/typescript-properties.test.ts

[Source](../../tests/typescript-properties.test.ts).

- resolved minimal repository fixtures preserve the source reference without inventing overlays or tools
- resolved repository fixtures preserve optional overlay, staging, and tool declarations without mutating negotiated data
- resolved inline and generated fixtures retain their declared bytes and history
- canonical JSON round trips and hashes remain stable across key order
- Codex JSONL preserves Unicode messages and exact cumulative token counts
- CLI schemas preserve unassessed outcomes across serialization and reject lost required state

## Supporting source inventory

The dedicated schema fixture builders are
[`boundaries.ts`](../../tests/fixtures/schema/boundaries.ts),
[`constraints.ts`](../../tests/fixtures/schema/constraints.ts),
[`evidence-boundaries.ts`](../../tests/fixtures/schema/evidence-boundaries.ts),
[`extension-documents.ts`](../../tests/fixtures/schema/extension-documents.ts),
and [`rich-results.ts`](../../tests/fixtures/schema/rich-results.ts).
Their published-constraint mutations supply the expected invalid documents;
the implementation's validator result must not become its own oracle.

Real extension processes and host fixtures live in
[`extension.ts`](../../tests/fixtures/extension.ts),
[`extension-command.ts`](../../tests/fixtures/extension-command.ts),
[`engine-session.ts`](../../tests/fixtures/engine-session.ts),
[`instrumented-adapter.ts`](../../tests/fixtures/instrumented-adapter.ts),
[`cli-fixtures.ts`](../../tests/fixtures/cli-fixtures.ts), and
[`filesystem.ts`](../../tests/fixtures/filesystem.ts).
Their inputs are part of each named scenario, including mutation/refusal tables.

Implementation context inspected for cross-record and algorithm details:
[`extension-client.ts`](../../src/extension-client.ts),
[`extension-session.ts`](../../src/extension-session.ts),
[`results.ts`](../../src/results.ts), [`report.ts`](../../src/report.ts), and
[`identity.ts`](../../src/identity.ts). These sources explain existing behavior;
the retained public contracts and independent test expectations govern parity.
The general engine, CLI and shared-property suites in the inventory also appear
in the other port-spec sections and remain a single acceptance obligation.
