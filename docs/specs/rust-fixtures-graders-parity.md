# Rust parity: fixtures, graders, and workspace ownership

This reference records the observable fixture, grading, and ownership behavior
that the Rust port must preserve. Its baseline is the TypeScript implementation
and tests at `1400f3f`; inspected source and test files are unchanged at the first
port documentation commit. This is a specification derived by inspection, not a
record of executed tests or completed Rust coverage.

The governing public contracts are [extension protocol v1](../extension-protocol-v1.md),
[built-in graders v1](../builtin-graders-v1.md), [results v1](../results-v1.md),
[runtime v1](../runtime-v1.md), and [advisory fixtures](../advisory-fixture.md).
Those contracts remain authoritative where the tests exercise only a subset.
The Rust implementation may change internal APIs, but must preserve serialized
declarations, retained evidence, process effects, containment, and result states.

Each table names exact existing test titles, or the literal title template used
by a parameterized test. Parameter values are stated beside the required result.
The expected results below are independent oracles: use literal output, filesystem
bytes, Git state, process receipts, and retained evidence rather than the port's
own helper functions to calculate expectations.

## Inventory and seams

| Area                         | Baseline suites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Observable seam                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Preparation and declarations | [preparation.test.ts](../../tests/preparation.test.ts), [artifact-preparation.test.ts](../../tests/fixtures/artifact-preparation.test.ts), [declaration-validation.test.ts](../../tests/fixtures/declaration-validation.test.ts), [fixture-setup-validation.test.ts](../../tests/evaluation/fixture-setup-validation.test.ts)                                                                                                                                                                                             | Serialized input to validated fixture/artifact plan; refusal before host admission |
| Materialization              | [fixture-setup.test.ts](../../tests/fixture-setup.test.ts), [repository-fixture.test.ts](../../tests/repository-fixture.test.ts), [repository-snapshots.test.ts](../../tests/fixtures/repository-snapshots.test.ts), [generated-fixture.test.ts](../../tests/generated-fixture.test.ts), [fixture-bin.test.ts](../../tests/fixture-bin.test.ts), [executable-installation.test.ts](../../tests/fixtures/executable-installation.test.ts), [workspace-lifecycle.test.ts](../../tests/fixtures/workspace-lifecycle.test.ts) | Real temporary directory, real Git process, real setup executable                  |
| Deterministic grading        | [output-grader.test.ts](../../tests/output-grader.test.ts), [output-grader-boundaries.test.ts](../../tests/output-grader-boundaries.test.ts), [shell-grader.test.ts](../../tests/shell-grader.test.ts), [generated-fixture.test.ts](../../tests/generated-fixture.test.ts)                                                                                                                                                                                                                                                | Check declaration plus actual final response, shell result, or Git state           |
| Semantic grading             | [semantic-grader.test.ts](../../tests/semantic-grader.test.ts), [semantic-grading-failures.test.ts](../../tests/evaluation/semantic-grading-failures.test.ts)                                                                                                                                                                                                                                                                                                                                                             | Separate host request/response and source-document filesystem access               |
| Advisory review              | [advisory.test.ts](../../tests/advisory.test.ts), [advisory-fixture.test.ts](../../tests/advisory-fixture.test.ts), [advisory-isolation.test.ts](../../tests/fixtures/advisory-isolation.test.ts), [advisory-failures.test.ts](../../tests/evaluation/advisory-failures.test.ts)                                                                                                                                                                                                                                          | Independent Git view and bounded reviewer response                                 |
| Ownership and retention      | [run-owner.test.ts](../../tests/run-owner.test.ts), [run-owner-checkpoints.test.ts](../../tests/run-owner-checkpoints.test.ts), [trial-retention.test.ts](../../tests/evaluation/trial-retention.test.ts), [CLI trial retention](../../tests/cli/trial-retention.test.ts), [engine.test.ts](../../tests/engine.test.ts)                                                                                                                                                                                                   | Competing real processes, persistent ownership/checkpoint records, cleanup effects |
| Cross-boundary acceptance    | [preparation-validation.test.ts](../../tests/evaluation/preparation-validation.test.ts), [CLI fixture preparation](../../tests/cli/fixture-preparation.test.ts), [provenance.test.ts](../../tests/fixtures/provenance.test.ts)                                                                                                                                                                                                                                                                                            | Preflight, public CLI, comparison identity                                         |

Test support in `tests/fixtures/` includes shared filesystem constructors,
extension peers, host adapters, and schema documents. These support the tests;
their implementation details do not replace the observable acceptance oracle.

## Preparation bytes and containment

Sources: [preparation.test.ts](../../tests/preparation.test.ts) and
[artifact-preparation.test.ts](../../tests/fixtures/artifact-preparation.test.ts).

| Test title                                                                               | Required observation                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preparation validates bytes, digest, and portable path containment`                     | Decode the declared bytes exactly and verify SHA-256. Reject `../outside`, collisions with a fixture file, parent/child collisions, noncanonical base64, an inline-only call with a source reference, and a mismatched digest. Preserve boolean `gitExclude`/`executable`; reject string flags. A Git-excluded path containing a newline is refused. |
| `source references resolve only from the declared case source map`                       | Only a declared `file:///` source within the canonical declared root can supply bytes. Preserve artifact flags. Missing source context, an undeclared reference, an outside path, an escaping source symlink, bad digest, or nonboolean flag refuses preparation.                                                                                    |
| `preparation artifacts cannot follow fixture symlinks`                                   | A symlink parent is a non-directory refusal; an existing final symlink is an already-existing-path refusal. A new nested path is accepted. The external directory stays empty.                                                                                                                                                                       |
| `refuses base64 with noncanonical pad bits even when its decoded bytes match the digest` | Canonical base64 for `f` is accepted; `Zh==` is rejected even though a permissive decoder produces the same byte.                                                                                                                                                                                                                                    |
| `resolves mixed inline and declared source artifacts with exact bytes and flags`         | Resolve both artifacts in declaration order; mapped bytes are exactly `source bytes\n`; `gitExclude: true` and `executable: false` remain explicit; source bytes are unchanged.                                                                                                                                                                      |
| `refuses preparation with ${refusal.name} and preserves declared source bytes`           | Reject unreadable root, non-file URL, missing file, and directory source. Preserve the declared source's `prepared\n` bytes.                                                                                                                                                                                                                         |
| `refuses a preparation declaration with both inline bytes and a mapped source`           | Refuse two content sources; do not choose one silently.                                                                                                                                                                                                                                                                                              |
| `refuses a regular file as an artifact parent without replacing its bytes`               | Refuse `assets/prepared.txt` when `assets` is a regular file; preserve `existing content`.                                                                                                                                                                                                                                                           |

The [preparation source](../../src/fixtures/preparation.ts) additionally defines
the portable path grammar (nonempty relative `/` segments; no backslash, colon,
empty segment, `.` or `..`), case-insensitive collision checking, unique nonempty
artifact IDs, an 8 MiB artifact limit, and a 32 MiB aggregate byte limit. These
source-derived bounds remain part of parity even where the focused tests above
do not exercise every exact edge. Mounts must never overwrite an existing target.

The authorized Rust size clarification keeps those limits inclusive: canonical
source artifacts of exactly 8 MiB are accepted, and one additional byte is
refused. Rust intentionally does not reproduce Bun 1.3.13's regular-expression
failure on the canonical base64 generated from an 8 MiB source. The observed
TypeScript rejection, maintainer decision, and public Rust boundary regression
are retained in the [artifact evidence ledger](rust-tdd-preparation-artifacts.md#approved-individual-source-size).
This exception does not remove the 8 MiB per-artifact or 32 MiB aggregate bounds.

## Generated and repository fixtures

Sources: [declaration validation](../../tests/fixtures/declaration-validation.test.ts).

| Test title                                                                     | Required observation                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generated fixture declarations refuse ${invalid.name}`                        | Refuse scalar declaration; unknown top-level/commit properties; non-string overlay/commit bytes; non-array staged paths or commits; nonboolean `commitFiles`; nonobject commit; blank commit message; empty commit file map; and case-colliding overlay paths. The valid baseline still has one commit. |
| `repository fixture declarations refuse ${invalid.name}`                       | Refuse array declaration, unknown property, non-string overlay, non-array staged paths, nonboolean `commitFiles`, parent/child collision, duplicate staged paths, and committed scaffolding without files. Preserve the valid source reference.                                                         |
| `serialized %s fixture declarations refuse nonobject hook and executable maps` | Both `generated` and `repository` reject `hooks: []` and `bin: null`.                                                                                                                                                                                                                                   |
| `repository declarations bound overlay count and total UTF-8 bytes`            | Accept 1,024 small overlay files; reject a 1,025th and an overlay containing 32 MiB of data plus its path bytes.                                                                                                                                                                                        |
| `generated declarations bound all history file entries and total UTF-8 bytes`  | Accept 1,024 small history entries; reject an additional overlay entry and a 32 MiB content value once declaration overhead is counted.                                                                                                                                                                 |

Generated history is bounded to 128 commits. The
[generated fixture source](../../src/fixtures/generated.ts) counts commit messages,
file paths/content across history and overlay, and staged path bytes toward the
32 MiB budget; repeated history entries consume the 1,024-entry budget. Commit
messages are nonblank and at most 4,096 UTF-8 bytes. Paths containing any
case-insensitive `.git` segment are refused. Stage declarations name overlay
files and cannot repeat by case. These are declaration checks before materialization.

Sources: [generated-fixture.test.ts](../../tests/generated-fixture.test.ts),
[repository-fixture.test.ts](../../tests/repository-fixture.test.ts), and
[repository-snapshots.test.ts](../../tests/fixtures/repository-snapshots.test.ts).

| Test title                                                                                                | Required observation                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `generated fixture builds stable history and a declared index state`                                      | Two materializations have equal HEAD revisions. The latest two messages are `feat: revise` then `chore: initialize`. Overlay README bytes are `staged\n`, with `M  README.md` and `?? notes.txt`. Reject root/nested Git metadata and staging an undeclared path. `commitFiles` adds `Add evaluation scaffolding` and leaves a clean tree. |
| `engine gives each generated trial the same history and a fresh working tree`                             | Both trials start at the same revision and declared staged README state; a scratch file written by one is absent in the next. Evaluation exits 0.                                                                                                                                                                                          |
| `generated Git hooks run for host commits after fixture preparation`                                      | A declared pre-commit hook does not stop runner initialization; it does stop the candidate commit with `hook blocked commit`, preserving baseline HEAD. Reject `../pre-commit`.                                                                                                                                                            |
| `fixture binaries reach the host and isolated shell checks`                                               | Host receives `.git/fixture-bin`; its tool and the isolated shell check both run and produce `fixture tool\n`. Task passes. Reject a binary name `../fixture-tool`.                                                                                                                                                                        |
| `repository fixtures clone a declared clean commit without remotes`                                       | Each of two trials reads original README bytes and no remotes. Refuse dirty source. After committing source changes, fixture identity changes. A mapped source outside its root is refused.                                                                                                                                                |
| `repository overlays preserve source, index state, and metadata boundaries`                               | Candidate overlay bytes/staging/untracked state are correct while HEAD equals source HEAD. Source bytes/tree remain clean. `commitFiles` creates the scaffolding commit before installing a failing hook and executable. Refuse `.git/config` overlays and an existing symlink target without changing source bytes.                       |
| `repository resolution refuses an undeclared source reference without changing the declared source`       | Refuse an unknown map key; preserve source HEAD and clean status.                                                                                                                                                                                                                                                                          |
| `repository source maps refuse a ${invalid.name}`                                                         | Reject non-file URL, missing repository, and regular file; preserve source revision.                                                                                                                                                                                                                                                       |
| `repository source resolution refuses a nested directory instead of the declared repository root`         | A subdirectory of a repository cannot substitute for its declared Git root.                                                                                                                                                                                                                                                                |
| `repository cloning refuses a source revision that changed after resolution`                              | If HEAD advances between resolve and clone, refuse `source changed during run` and leave the destination empty.                                                                                                                                                                                                                            |
| `repository overlay refuses a regular file as a parent and retains its original bytes`                    | Refuse `README.md/child.txt` over the existing file, preserving baseline README and HEAD.                                                                                                                                                                                                                                                  |
| `repository overlays create nested directories but refuse symlink parents and existing directory targets` | Create a safe nested file. Refuse a symlink parent and a directory final target; retain the previously written safe bytes.                                                                                                                                                                                                                 |
| `repository fixtures preserve pinned submodule declarations with %s sources`                              | For initialized and uninitialized sources, copy exact HEAD, `.gitmodules`, and mode-160000 pinned gitlink. Candidate submodule remains empty/uninitialized; no remote or dirt is introduced. Source HEAD/status/submodule status/module file stay unchanged. No fetch of the unavailable declared URL is required.                         |
| `repository fixtures refuse ignored submodule %s changes before candidate execution`                      | Tracked content, untracked content, and submodule revision changes are refused even when `.gitmodules` sets `ignore=all` and normal parent status appears clean. Host call count stays zero.                                                                                                                                               |

## Fixture setup and executable boundaries

Sources: [fixture-setup.test.ts](../../tests/fixture-setup.test.ts),
[fixture-setup-validation.test.ts](../../tests/evaluation/fixture-setup-validation.test.ts),
[executable-installation.test.ts](../../tests/fixtures/executable-installation.test.ts),
and [fixture-bin.test.ts](../../tests/fixture-bin.test.ts).

| Test title                                                                                               | Required observation                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixture setup resolves symbolic roots and runs only the declared argv`                                  | Resolve `{{sevro.project}}/cases` and `{{sevro.workspace}}` into the declared environment. The executable writes exactly `<project>/cases\|<workspace>`. Refuse relative `bash` executable and reserved `PATH`.                                                  |
| `fixture setup failure and cancellation never report success`                                            | Setup exit 17 raises `fixture setup failed (17)`; a pre-aborted signal raises `fixture setup cancelled`.                                                                                                                                                         |
| `fixture setup validation preserves declared argv and environment placeholders without executing them`   | Return unchanged symbolic command/environment, default absent environment to `{}`, and absent setup to no setup. Validation has no process effects.                                                                                                              |
| `fixture setup validation refuses ${invalid.name} at its unknown-input boundary`                         | Reject null/array/scalar declarations; empty argv; non-string arguments; 17 argv items; argv above 64 KiB; NUL in argv; array/scalar environment; unknown top-level fields; 33 environment entries; serialized environment above 16 KiB; and NUL in environment. |
| `fixture executable installation replaces only an existing regular target and sets its executable mode`  | Replace existing regular bytes with the declared script and set mode `0755`.                                                                                                                                                                                     |
| `fixture executable installation refuses an existing %s target and preserves its contents`               | For directory and symlink targets, reject replacement and preserve external `original bytes`.                                                                                                                                                                    |
| `fixture executable installation refuses a %s directory boundary`                                        | For regular file and symlink directory boundaries, refuse installation; external directory remains empty.                                                                                                                                                        |
| `fixture executable installation reports a real inaccessible owned directory without changing its files` | A mode-000 directory produces an access error; restore access for inspection and find only unchanged original content.                                                                                                                                           |
| `fixture binary PATH refuses a Git directory redirected outside the workspace`                           | A `.git` symlink to an outside directory cannot contribute a binary directory to candidate PATH.                                                                                                                                                                 |

The [setup implementation](../../src/fixtures/setup.ts) and public extension
contract require an absolute executable, direct argv execution, at most 16
nonempty arguments, reserved environment protection, uppercase variable names,
and only the two supported symbolic roots. `HOME`, `TMPDIR`, and Git configuration
variables are also reserved. The trusted setup runs once per trial after history
and overlays, before evaluator artifacts and candidate admission, with a private
temporary home, no inherited credential variables, discarded output, and a
120-second deadline. Cancellation terminates its owned process group.

## Workspace creation and cleanup

Sources: [workspace-lifecycle.test.ts](../../tests/fixtures/workspace-lifecycle.test.ts)
and [CLI trial-retention.test.ts](../../tests/cli/trial-retention.test.ts).

| Test title                                                                                                                | Required observation                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `direct fixture creation owns a real empty temporary workspace without a reservation`                                     | Return a canonical real directory distinct from the project, initially empty and mode `0700`.                                                                                        |
| `direct fixture creation copies inline bytes and verified artifacts with private file modes`                              | Inline and prepared bytes match exactly; nested directory is `0700`, regular files `0600`, executable artifact `0700`. Candidate edits do not mutate input objects or source files.  |
| `direct Git fixture preparation excludes bracket and space filenames literally while retaining lookalike candidate files` | Exclude only `assets/[probe] file.txt`; `assets/p file.txt` remains visible in Git status. Preserve both contents and original HEAD.                                                 |
| `direct unreserved fixture creation removes its owned workspace after ordinary setup exit seven`                          | Raise the setup-exit error, remove that unreserved workspace, and leave setup script/source files intact.                                                                            |
| `engine refuses a setup-created regular file in place of the fixture binary directory`                                    | Reject `.git/fixture-bin` replaced by a setup-created file before any candidate call.                                                                                                |
| `engine clears nested permission-locked owned contents while retaining outside bytes and trial evidence`                  | After passing evaluation, remove nested mode-000 candidate directories; preserve external symlink target bytes/mode and saved raw `ready` response.                                  |
| `CLI supplies a canonical candidate workspace`                                                                            | Host-observed workspace path equals its realpath.                                                                                                                                    |
| `CLI removes a permission-locked candidate directory (%s)`                                                                | Remove locked child, mode-000 root, and mode-0500 root after successful persistence. Saved evidence equals CLI result. External linked directory/file bytes and modes are unchanged. |

Successful cleanup is after trial evidence persistence. Permission repair walks
owned real directories and never follows symlinks into protected targets. A direct
unreserved construction failure removes its owned directory; an engine-reserved
failed trial retains its workspace for inspection. The distinction is exercised
by the setup-exit tests here and in the next section.

Sources: [engine.test.ts](../../tests/engine.test.ts) and
[trial-retention.test.ts](../../tests/evaluation/trial-retention.test.ts).

| Test title                                                                                | Required observation                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed trial persistence retains its fixture and never returns success`                  | A directory blocking `trial-1.json` causes `trial persistence failed; fixture retained`; workspace remains, active record becomes `diagnostic`.                                                                               |
| `engine retains a failed candidate workspace while preserving saved evidence`             | Host failure yields exit 2, retained fixture bytes, existing evidence, and `sevro.observation.workspaces` naming candidate path.                                                                                              |
| `engine retains the semantic workspace when grading fails`                                | Grader exception yields exit 3 and retains the grader's `failure-details` file.                                                                                                                                               |
| `engine retains the candidate workspace when required grading evidence is unavailable`    | Completed host plus missing required evidence gives `completed/unavailable/not_assessed`, exit 4, and retains candidate/evidence files.                                                                                       |
| `engine startup expires inactive failed workspaces after a day without deleting evidence` | Preserve at 24 hours minus 1 ms; remove at 24 hours plus 1 ms on subsequent evaluation startup. Prior evidence bytes remain exact.                                                                                            |
| `engine startup preserves an active workspace older than a day`                           | A real blocked active host retains access to original fixture bytes while another evaluation performs expiry.                                                                                                                 |
| `engine startup removes expired ownership records after a workspace was deleted manually` | Remove the stale owner record when its expired retained directory is already absent.                                                                                                                                          |
| `engine startup preserves a workspace with unreadable ownership metadata`                 | Unreadable owner metadata cannot authorize deletion; fixture and prior evidence bytes survive.                                                                                                                                |
| `engine startup preserves expired workspaces with unverifiable ownership`                 | Preserve on broken/null JSON, unknown format/state, invalid timestamp, null/invalid/foreign owner, record over 4 KiB, public-readable record, missing record, and symlink record. Preserve external owner bytes and evidence. |
| `engine startup cleanup tolerates concurrent evaluations expiring the same workspace`     | Four concurrent evaluations may race to expire one old directory over ten rounds; all preserve their own exit-2 result and expired directory disappears.                                                                      |
| `ordinary trusted fixture setup failure stays a failure before candidate admission`       | Engine-reserved setup exit 7 rejects; host calls remain zero; baseline fixture remains readable.                                                                                                                              |
| `retains a failed host's raw response and artifacts before fixture cleanup`               | Keep raw `ready`, exact private trace bytes and SHA-256, complete observation, and failed candidate workspace; no grading checks are accepted.                                                                                |

The [workspace ownership source](../../src/fixtures/workspace-state.ts) uses an
owned private namespace and external `.owners` records; a candidate cannot create
deletion authority inside its own workspace. Unknown ownership, legacy folders,
and saved evidence are never cleanup candidates. Failed cleanup is retried by
later startup. These are contract requirements in addition to the focused tests.

## Output grader semantics

Sources: [output-grader.test.ts](../../tests/output-grader.test.ts) and
[output-grader-boundaries.test.ts](../../tests/output-grader-boundaries.test.ts).

| Test title                                                                        | Required observation                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `regex checks grade complete output and preflight invalid patterns`               | `^ready$` and negated `secret` both pass `ready` and fail `not ready secret`. Reject `(?i)ready` before execution.                                                                                                                                                                                                      |
| `JSON checks support pointers, exact values, and recursive containment`           | A single JSON fence containing alpha with exact ordered tags and beta passes `/items/0` equality and `/items` containment. `{}` fails both; alpha-only passes equality and fails containment. Reject `~2` pointer escaping.                                                                                             |
| `exact JSON checks reject surrounding prose`                                      | An exact fenced document passes; a prose prefix before that fence fails.                                                                                                                                                                                                                                                |
| `schema checks validate inline schemas without reading candidate paths`           | Inline schema requiring `status: ready` passes matching JSON; `wait` and non-JSON fail. No candidate-directed schema file read.                                                                                                                                                                                         |
| `missing or incomplete observations cannot pass any output check`                 | Null response or incomplete observation makes every output check `unavailable`, including a regex whose visible partial text would match.                                                                                                                                                                               |
| `composite output checks keep text and JSON assertions in one outcome`            | Combine valid JSON, inline schema, selected array containment, positive regex, negative regex. Lowercase JSON member `ready` passes; `READY` fails case-sensitive JSON containment despite regex `i`; prose prefix and forbidden `secret` fail; missing response is unavailable.                                        |
| `composite exact text matching is strict and validates patterns before execution` | `ready` passes and `ready\n` fails exact matching. Invalid regex and pointer declarations fail preflight.                                                                                                                                                                                                               |
| `output grader %s refuses invalid configuration %j`                               | Refuse unknown regex key, non-string pattern, nonboolean negate, non-string flags, non-string pointer, nonboolean `exactDocument`, non-string/invalid nested `$regex`, null/invalid inline schema, nonboolean `validJson`, non-string `expectExact`, JSON expectations without `jsonPath`, and flags without a pattern. |
| `output checks refuse empty or duplicate IDs: %s`                                 | Empty IDs and duplicate `same` IDs refuse preparation.                                                                                                                                                                                                                                                                  |
| `JSON pointer escaping selects the declared key and refuses scalar traversal`     | `/a~1b/~0key` selects false from keys `a/b` and `~key` and passes with `detail: ok`; traversing null fails with `JSON pointer does not resolve`; ordered equality `[1,2]` versus `[2,1]` fails.                                                                                                                         |
| `recursive JSON containment grades %s as %s`                                      | An array member with tags red/blue and string name alpha satisfies `{tags:[red,blue],name:{$regex:^a}}`. Missing tag, scalar tags, numeric name, null member, or non-array selected value fails.                                                                                                                        |
| `JSON document recovery accepts only one valid fence: %s`                         | Non-exact JSON accepts surrounding prose with one valid `json` fence; malformed fenced JSON and two fences fail.                                                                                                                                                                                                        |
| `composite output checks retain the first independent failure`                    | `not JSON` reports `output is not valid JSON`; `{}` reports schema failure; `status: wait` reports equality failure; extra text spacing with otherwise equal JSON reports exact-output failure; exact expected document passes.                                                                                         |
| `global regex checks reset between repeated observations`                         | Reusing a prepared regex with flag `g` passes the same `ready` text five times.                                                                                                                                                                                                                                         |

The [output implementation](../../src/graders/output.ts) compiles ECMAScript regex
syntax and always adds multiline mode. Rust's default regex syntax is not an
equivalent oracle. Composite order is JSON validity, schema, selected JSON value,
exact text, positive regex, negative regex. JSON equality is deep and ordered for
arrays; recursive subset arrays require each expected member to have a matching
actual member. A sole `$regex` object is a string predicate. Schema validation is
Draft 2020-12 with only inline references. Preserve absence versus explicit false,
null, empty values, and unavailable observations.

### Rust JSON pointer compatibility decision

Accepted user decision, 2026-10-16: Rust JSON pointer grading follows
[RFC 6901](https://www.rfc-editor.org/info/rfc6901/) for `sevro.json.pointer`
and `sevro.output.jsonPath`. Tokens select actual JSON
object members or array indexes. Inherited JavaScript properties and an array's
synthetic `length` property do not resolve. Explicit JSON object members named
`constructor` or `length` remain selectable. As required by RFC 6901 section 4,
a referenced member name occurring more than once in the same object does not
resolve; duplicate names unrelated to the selected token do not affect that
lookup.

This deliberately differs from the historical TypeScript implementation's
inherited-property, array-length, and last-duplicate-member behavior. The authority
is the user's answer, "Follow RFC 6901 (Recommended)", to the compatibility question about
those two behaviors (provenance: user statement). The existing
[built-in grader contract](../builtin-graders-v1.md) already specifies RFC 6901
for `sevro.json.pointer` (provenance: repository fact). The Rust
[implementation ledger](rust-tdd-graders.md) records the applicable evidence;
it does not establish a separate policy.

### Rust JSON containment compatibility decision

Accepted user decision: recursive JSON containment compares actual JSON
members. Object subset keys must exist as explicit members of the parsed
candidate object; inherited JavaScript properties do not satisfy them. An
explicit object member named `__proto__` remains an ordinary JSON member and
is compared recursively. Existing array subset and regex predicate semantics
remain unchanged.

The authority is the user's answer, "Compare actual JSON members (Recommended)"
(provenance: user statement). This is a separate choice from RFC 6901 pointer
selection. It does not redefine schema evaluation or other JavaScript behavior.

The observed legacy TypeScript CLI passes `contains: {"__proto__": {}}` against
the exact response `[{}]`, although the candidate object has no own members.
Rust deliberately fails that assertion with completed execution and grading,
exit 1, and detail `JSON array did not contain expected item`; it retains the
final-message evidence. The [implementation ledger](rust-tdd-graders.md#accepted-own-member-containment-decision)
records this accepted difference and its honest initial-green public regression.

## Shell grader semantics and isolation

Source: [shell-grader.test.ts](../../tests/shell-grader.test.ts).

| Test title                                                                          | Required observation                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell declarations reject invalid commands and bounds`                             | Default expected exit is 0 and timeout 30,000 ms. Refuse empty command, zero timeout, exit 256, unknown key, invalid regex, duplicate flags, and nonempty flags without a pattern.                                                                              |
| `shell declarations retain UTF-8 output and regex limits at their public boundary`  | Refuse empty check ID. Exact expectation accepts 262,144 four-byte emoji (1 MiB), rejects one more or a number. Regex accepts 4,096 characters and rejects 4,097 or non-string negative pattern.                                                                |
| `shell assessment refuses missing required stdout and distinguishes regex mismatch` | Captured stdout `null` is an error. Unmatched text yields failed detail `expected shell output pattern did not match`, without echoing that private text. `ready\n` matches `^ready$`.                                                                          |
| `shell stdout assertions preserve exact and multiline matching semantics`           | Exact matching removes exactly one final LF; `first\nsecond\n` satisfies exact/positive/negative assertions. Wrong exact text and forbidden pattern fail. Exit mismatch takes precedence over output matching.                                                  |
| `a pre-aborted shell check refuses admission before preparing runtime state`        | Report cancellation before creating `.git/sevro-runtime`.                                                                                                                                                                                                       |
| `shell cancellation requested during preparation stops its eventual owned process`  | Immediate cancellation while preparing a `sleep 30` check rejects with cancellation.                                                                                                                                                                            |
| `active shell cancellation stops only the receipt-bound owned process`              | Wait for a real PID/readiness receipt and heartbeat, cancel, observe stopped heartbeat; on macOS the recorded process no longer exists.                                                                                                                         |
| `timed out shell checks stop without returning a result`                            | A 50 ms limit on `sleep 10` raises timeout and does not return a gradeable process result.                                                                                                                                                                      |
| `shell runtime refuses a regular file in place of its required isolated UV cache`   | A file at the expected UV cache path refuses runtime setup.                                                                                                                                                                                                     |
| `isolated shell checks can use an explicit toolchain`                               | Declared tool runs; UV cache exists, `UV_OFFLINE=1`, `PYTHONDONTWRITEBYTECODE=1`, and project environment path is set.                                                                                                                                          |
| `shell scratch files stay inside Git metadata`                                      | HOME/TMPDIR writes land under `.git/sevro-runtime/check-home` and `check-tmp`; legacy `.sevro-check-*` directories are absent.                                                                                                                                  |
| `shell check sees the fixture but cannot read or write protected sources`           | Fixture reads succeed; protected source reads/writes fail; API/GitHub credential variables are empty. Capture multiline stdout when asserted. `false; printf wrong` stops with exit 1 and empty stdout. More than 1 MiB captured stdout raises a grading error. |
| `shell local HTTP opt-in runs a real server while refusing outbound TCP`            | Explicit runtime local HTTP produces exact `local-http-ok\n` with exit 0 while outbound TCP remains denied.                                                                                                                                                     |

Source: [engine.test.ts](../../tests/engine.test.ts).

| Test title                                                                    | Required observation                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell checks grade fixture effects and retain exit observations`             | Grade a candidate-created `done\n` file, preserve declared check order, and reference `sevro.observation.shell.file-created`. Complete observation records actual/expected exit 0, a SHA-256 digest, and byte length 5; active graders include `sevro.shell`.                                     |
| `shell failures and timeouts remain distinct from host completion`            | Missing file or stdout mismatch gives `completed/completed/failed`, exit 1. Timeout gives `completed/error/not_assessed`, exit 3. Missing explicit protected roots is a preflight error.                                                                                                          |
| `stores checkpoints apart from results and hides run state from shell checks` | With independent state root, shell cannot read private state. Active record is `sevro.active-run.v1`, complete, and links evidence/checkpoint/completed trial. Checkpoint is `sevro.run-checkpoint.v1` with matching trials. Results root has no `active` directory; private state bytes survive. |

The [shell implementation](../../src/graders/shell.ts) executes `sh -e`, permits
exit codes 0–255 and timeouts 1–120,000 ms, bounds run strings and patterns to
4,096 JavaScript string units, and permits distinct optional flags `i`, `s`, `u`
in addition to automatic `m`. Without stdout assertions it discards output;
with assertions it captures at most 1 MiB and rejects invalid UTF-8. Retained
evidence exposes digest/byte length rather than raw private stdout. Runtime,
credential, candidate-artifact, and transcript grants must retain the boundaries
defined in [runtime v1](../runtime-v1.md).

## Git HEAD grading

Source: [generated-fixture.test.ts](../../tests/generated-fixture.test.ts).

| Test title                                                                                | Required observation                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Git HEAD capture with a live cancellation signal retains the real revision and ancestry` | Read actual HEAD and report current revision equal to it with `baseAncestor: true`; signal stays un-aborted and tree stays clean.                                                                                                                                                 |
| `Git HEAD capture honours cancellation %s without changing fixture history`               | Cancellation before capture and during metadata preflight raises `Git HEAD check cancelled`; original HEAD/status remain unchanged.                                                                                                                                               |
| `Git HEAD state refuses nonimmutable base revision %j before reading the fixture`         | Refuse `HEAD`, empty string, 39 hex characters, and 40 nonhex characters before attempting a nonexistent fixture.                                                                                                                                                                 |
| `Git HEAD grading binds the base revision outside candidate control`                      | Advancing HEAD passes changed/ancestor checks; rewinding passes changed but fails ancestor and fails the task; unchanged HEAD passes unchanged. Complete retained Git observation names source `sevro.git-head` and ancestry.                                                     |
| `Git HEAD grading reports an error after candidate ${failure.name}`                       | Replacing `.git` with a file, removing HEAD, or replacing history without the captured base yields `completed/error/not_assessed`, exit 3, diagnostic `sevro.grader.error` / `Git HEAD grading did not complete`; no complete Git observation; candidate README remains retained. |
| `Git HEAD checks reject invalid configuration and non-Git fixtures`                       | Inline fixtures and invalid kind `guess` are refused before host execution.                                                                                                                                                                                                       |

Base revision must be captured before candidate execution in runner-owned state.
Candidate-written metadata cannot redefine the comparison baseline. Broken Git
state is a grader error, distinct from a valid but failing ancestry assertion.

## Semantic response and document grading

Sources: [semantic-grader.test.ts](../../tests/semantic-grader.test.ts),
[output-grader-boundaries.test.ts](../../tests/output-grader-boundaries.test.ts), and
[semantic-grading-failures.test.ts](../../tests/evaluation/semantic-grading-failures.test.ts).

| Test title                                                                                                                             | Required observation                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `semantic declarations refuse a missing or repeated check ID %j`                                                                       | Empty or repeated `meaning` ID refuses preparation.                                                                                                                                                                                                                 |
| `semantic grader binds one verdict to each declared proposition`                                                                       | Prompt contains candidate data with `<ignore me>` escaped as JSON Unicode escapes. Accept complete fenced pass/fail verdicts with reasons. Refuse omitted or repeated check IDs and absent proposition.                                                             |
| `semantic serialized verdicts refuse $label`                                                                                           | Reject null/array result, extra root property, non-array checks, nonobject verdict, undeclared ID, unknown verdict, blank/non-string reason, and 4,097-character reason.                                                                                            |
| `semantic response size includes otherwise valid JSON whitespace`                                                                      | Whitespace contributes to the 1 MiB response bound.                                                                                                                                                                                                                 |
| `semantic prompt bounds the combined declared propositions before route execution`                                                     | 1,024 individually valid 8 KiB propositions exceed the 8 MiB combined prompt budget and refuse route execution.                                                                                                                                                     |
| `semantic grading groups multiple propositions by response and document and preserves failed assessment`                               | Separate response/document groups invoke the semantic host once per source in empty workspaces. Each receives only its own propositions/content. Preserve check order `[passed, failed, passed, passed]`, route evidence, and `completed/completed/failed`, exit 1. |
| `semantic artifact declarations refuse invalid ordinary value $path`                                                                   | Refuse null, false, number, array, object, empty/blank path, absolute path, parent traversal, `.git`, backslash, directory wildcard, and repeated basename wildcard.                                                                                                |
| `semantic artifact directory links stay contained and preserve external document bytes`                                                | An in-fixture directory link may resolve to `docs/answer.md` and return exact content; an outside directory link is refused without modifying external bytes.                                                                                                       |
| `semantic grading associates two reversed verdicts with their declared criteria`                                                       | Associate by ID, return checks in declaration order, and retain original reversed raw JSON unchanged. One fail yields exit 1.                                                                                                                                       |
| `semantic grading refuses a valid prefix followed by ${id === "first" ? "a duplicate" : "an unknown"} ID without accepting the prefix` | Refuse duplicate/unknown ID after a valid entry atomically: empty accepted checks/verdict observations, grader-error diagnostic, `completed/error/not_assessed`, exit 3. Retain original malformed-by-contract verdict JSON.                                        |
| `keeps semantic grading unavailable for a ${candidate.name} candidate without calling the grader`                                      | Absent or partial candidate response produces zero semantic calls, unavailable check with empty evidence references, `completed/unavailable/not_assessed`, exit 4.                                                                                                  |
| `refuses a failed semantic host even when its output contains a passing verdict`                                                       | `executionFailed: true` invalidates otherwise passing output; exit 3, task unassessed. Retain raw verdict and namespaced trace bytes.                                                                                                                               |
| `semantic grading bounds raw verdict retention for ${response.name} output`                                                            | Exactly 1 MiB of valid padded response is retained and accepted; absent or larger output is not retained and is a grader error with no checks. Bounded side trace is retained in every case. Successful grader workspace is removed; failed workspace remains.      |
| `retains ${grader.name} semantic output and its workspace for grading-error inspection`                                                | Malformed JSON or incomplete semantic response yields exit 3 with raw output and workspace retained.                                                                                                                                                                |
| `refuses ${artifact.name} semantic documents without calling the grader`                                                               | Missing, ambiguous `*.md`, or 64 KiB+1 document causes zero grader calls, exit 3, and retains candidate raw `ready`.                                                                                                                                                |

The [semantic contract](../builtin-graders-v1.md) requires one nonempty proposition
of at most 8 KiB per check and one exact pass/fail/reason result for each declared
ID. Response checks and artifact checks are grouped independently. A document
must resolve to exactly one regular contained file of at most 64 KiB, with at
most one basename wildcard. Retain resolved path and content digest. The empty
semantic workspace receives bounded untrusted data, not candidate instructions.
The semantic route, usage, raw `sevro.semantic.verdicts`, observations, and
namespaced artifacts remain separate from candidate evidence. Dependency seeds
for response grading require explicit `semantic` role; artifact grading retains
default selection. The engine test `semantic checks use an isolated grader route
and retain verdict evidence` additionally verifies route list, exact trace bytes,
no call on incomplete candidate evidence, and explicit-route preflight.

## Blind advisory review

Sources: [advisory-fixture.test.ts](../../tests/advisory-fixture.test.ts) and
[advisory-isolation.test.ts](../../tests/fixtures/advisory-isolation.test.ts).

| Test title                                                                                                | Required observation                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advisory fixture shows the full candidate change without condition files or source history`              | Review final committed/unstaged/deleted/untracked candidate files. Hide root `.agents`, `.claude`, `.codex`, and explicit `private.txt`. Git history contains only `Advisory baseline`; no remotes. Diff includes final value 3 and removed obsolete file but no condition bytes. |
| `advisory baseline refuses a %s without changing its contents`                                            | Non-Git directory and unborn repository cannot supply baseline; preserve uncommitted README and unborn status.                                                                                                                                                                    |
| `advisory fixture refuses an unavailable immutable baseline and preserves the candidate change`           | Unavailable all-zero revision is refused; source HEAD/status/README/candidate file remain exact.                                                                                                                                                                                  |
| `advisory exclusions refuse reserved metadata path %s before copying source`                              | Refuse `.git`, `.GIT`, `.git/HEAD`, and `.GiT/config` exclusions; preserve source.                                                                                                                                                                                                |
| `advisory fixture refuses more than 1024 untracked files without changing source inputs`                  | Refuse 1,025 files; preserve all names/content and source Git state.                                                                                                                                                                                                              |
| `advisory fixture refuses untracked bytes above 32 MiB without changing source inputs`                    | Refuse 32 MiB+1 untracked bytes; original file size/digest/Git state remain exact.                                                                                                                                                                                                |
| `advisory fixture refuses Git output above 16 MiB with its cause and source inputs intact`                | Refuse oversized binary diff with contextual Git-operation error and cause `advisory fixture Git output is too large`; preserve original content and diff digests.                                                                                                                |
| `advisory fixture rejects escaping untracked symlinks`                                                    | Refuse relative escape; original path remains a symlink.                                                                                                                                                                                                                          |
| `advisory fixture rejects a tracked symlink chain that escapes`                                           | Refuse indirect tracked escape.                                                                                                                                                                                                                                                   |
| `blind advisory review copies contained untracked symlinks and nested files without sharing source bytes` | Canonical view retains contained relative link and content, creates distinct file inode, has no remotes; reviewer edit does not mutate source.                                                                                                                                    |
| `blind advisory review refuses a ${tracked ? "tracked" : "untracked"} broken symlink`                     | Refuse either broken-link form and preserve source link target.                                                                                                                                                                                                                   |
| `blind advisory review requires an immutable base revision rather than a moving ref`                      | Refuse `HEAD` while preserving source revision.                                                                                                                                                                                                                                   |
| `blind advisory review refuses an absolute symlink back to the source checkout`                           | Even an absolute link to the supplied source is an escape in the independent view; source bytes/link survive.                                                                                                                                                                     |

Review baseline and change both omit condition/evaluator paths. Copy all relevant
committed, staged, unstaged, and non-ignored untracked candidate changes onto one
synthetic baseline. The view has no original history or remote and shares no
writable file data with candidate/source. Failed construction removes the owned
temporary view, as required by [advisory fixture contract](../advisory-fixture.md).

Sources: [advisory.test.ts](../../tests/advisory.test.ts),
[advisory-failures.test.ts](../../tests/evaluation/advisory-failures.test.ts), and
[engine.test.ts](../../tests/engine.test.ts).

| Test title                                                                               | Required observation                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `advisory assessment accepts a structured independent review`                            | Accept exact plain or fenced JSON and preserve verdict, score, four dimensions, strengths, weaknesses, summary.                                                                                                                                                                                                                                                                |
| `advisory external JSON refuses $label`                                                  | Refuse null/array root or dimensions, unknown verdict, string/fractional/0/6 score, invalid dimension score, non-array lists, and 33 strengths/weaknesses.                                                                                                                                                                                                                     |
| `advisory assessment accepts the exact list bound and retains a valid low-score failure` | Accept 32 entries in each list and `fail` with overall score 1.                                                                                                                                                                                                                                                                                                                |
| `advisory assessment rejects weak passes, extra fields, and oversized output`            | Refuse `pass` with score 2, unknown `taskVerdict`, empty summary, and 64 KiB+1 output.                                                                                                                                                                                                                                                                                         |
| `advisory prompt records omitted check detail as unknown without inventing evidence`     | Missing detail serializes as null, not empty string; preserve `unavailable` check state.                                                                                                                                                                                                                                                                                       |
| `advisory prompt keeps task and check facts explicit and bounded`                        | Include task and deterministic status, state advisory authority, and refuse empty task.                                                                                                                                                                                                                                                                                        |
| `advisory review inspects a blind change and cannot alter task grading`                  | Reviewer sees changed app/new test but no condition file. A valid failing review (score 2), malformed review, or thrown reviewer exception leaves deterministic task passed/exit 0. Retain advisory route, independent usage 40/20, raw response/trace. Dry review is `not_run` without additional reviewer call. Inline fixture or `.git/config` exclusion refuses preflight. |
| `records a failed advisory host without accepting its passing assessment`                | Host execution failure makes review failed with null assessment despite passing JSON. Task still passes with exit 0; retain raw response, bounded namespaced trace, and failed reviewer workspace.                                                                                                                                                                             |
| `advisory review bounds raw response retention for ${response.name} output`              | Absent or over-64-KiB output yields failed review and no raw path/digest; exactly 64 KiB valid padded JSON is retained and accepted. Trace bytes persist in all cases. Failed view remains; successful view is removed. Task remains passed/exit 0.                                                                                                                            |

The [advisory parser](../../src/advisory.ts) requires exactly the six root fields
and four named dimensions. Scores are integers 1–5; pass requires overall at
least 3. Text fields/list members are nonblank and at most 4,096 JavaScript string
units; lists have at most 32 entries. Prompt task is at most 64 KiB and there are
at most 128 check facts, each detail bounded to 4,096 units. Advisory evidence
cannot change execution, required grading, task verdict, or exit code; failure
to persist that evidence is still an internal persistence error.

## Run ownership, checkpoints, and interruption

Sources: [run-owner.test.ts](../../tests/run-owner.test.ts) and
[run-owner-checkpoints.test.ts](../../tests/run-owner-checkpoints.test.ts).

| Test title                                                                                              | Required observation                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a live owner blocks an equivalent run until finalization`                                              | A second attempt for the same evaluation digest cannot claim while the first owner lives. After complete checkpoint, next attempt succeeds and first active record remains complete.            |
| `an unverifiable owner is refused and a changed process start can be reclaimed`                         | Null owner is refused. Same PID with different recorded process start is stale; reclaim under new attempt while marking prior active record and retained `run-owner.json` interrupted.          |
| `refuses a malformed process start time without replacing ownership evidence`                           | Numeric start time cannot prove death; refuse and preserve claim bytes and active status.                                                                                                       |
| `rejects nonstring retained ownership paths before checking liveness`                                   | Numeric `activeRunPath`, `evidenceDirectory`, or `artifactPath` yields unrecognized-record error without overwriting bytes.                                                                     |
| `an abruptly killed owner can be reclaimed without losing its attempt record: %s`                       | Start real child owner, wait for readiness, SIGKILL and await exit; reclaim for retained and null active-record cases. Keep interrupted prior attempt record and retained ownership provenance. |
| `a %s finalized owner permits a new attempt while retaining its own status`                             | For diagnostic and interrupted finalization, preserve prior run ID, empty completed trials, finalization timestamp, status, and exact active-record bytes; new claim is active.                 |
| `refuses a checkpoint with ${refusal.name} and preserves retained evidence`                             | Changed attempt, finalized claim, or null/unverifiable owner refuses checkpoint. Original checkpoint, active record, and changed claim bytes remain exact.                                      |
| `refuses a checkpoint when its claim disappears without rewriting evidence`                             | Missing ownership claim refuses checkpoint; existing checkpoint/active bytes survive.                                                                                                           |
| `reclaims a stale process identity with a missing active record while retaining interrupted provenance` | Reconstruct interrupted active record with original run ID, artifact path, empty completed trials; retain interrupted ownership evidence and admit new active attempt.                          |
| `refuses a stale owner with malformed active evidence without discarding its record`                    | Broken active JSON refuses reclamation; prior claim and broken bytes remain exact.                                                                                                              |
| `refuses an owner with ${replacement.name} without replacing its evidence`                              | Foreign host, PID 0, and empty process start are unverifiable; claim and active bytes survive.                                                                                                  |
| `refuses a retained claim for another evaluation identity without changing it`                          | Mismatched evaluation digest is refused even at the expected claim path.                                                                                                                        |
| `keeps an owner active and removes temporary files when checkpoint persistence fails`                   | If checkpoint path becomes a directory, finalization fails; in-memory owner remains active, claim/active bytes unchanged, and no temporary files remain.                                        |
| `owner admission refuses an invalid evaluation digest before retaining state: %s`                       | Reject malformed string, uppercase 64-character hex, and 63-character hex; state root remains empty.                                                                                            |
| `owner admission refuses a %s claim without replacing checkpoint evidence`                              | A directory or unreadable claim prevents admission without replacing active/checkpoint evidence.                                                                                                |
| `ordinary damaged claim JSON cannot establish owner authority: %j`                                      | Null claim and unknown/array status refuse with unrecognized-record error; malformed bytes remain and previous active record stays active.                                                      |

The [owner source](../../src/run-owner.ts) serializes admission/checkpoint mutation
per evaluation identity, currently with a SQLite immediate transaction. A Rust
replacement must preserve cross-process exclusion and crash recovery, including
existing on-disk formats `sevro.run-owner.v1`, `sevro.active-run.v1`, and
`sevro.run-checkpoint.v1`. Liveness binds host, positive PID, and process-start
identity; PID existence alone is insufficient. Unknown ownership fails closed.
Writes use private files and atomic replacement. A failed write cannot report
finalized ownership or successful assessment.

Sources: [evaluation trial retention](../../tests/evaluation/trial-retention.test.ts)
and [CLI trial retention](../../tests/cli/trial-retention.test.ts).

| Test title                                                                                                           | Required observation                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `active trusted fixture setup cancellation retains an interrupted unassessed run before candidate admission`         | Wait for setup readiness, SIGINT cancellation, zero candidate calls; result `cancelled/not_requested/not_assessed`, exit 130, with cancelled retained run evidence.                                                |
| `fixture setup interruption retains a prior completed trial and one cancelled partial attempt`                       | Sequential second setup blocks; cancellation preserves first passed trial/raw `ready` plus one cancelled unassessed partial attempt. Host called once; partial candidate duration and raw path are null; exit 130. |
| `ownership initialization failure removes separately allocated run and state directories before candidate admission` | Blocking `owners` file refuses admission; host never called; results root empty; state root preserves only `locks` and original `owners` file.                                                                     |
| `retains semantic-phase cancellation and interrupted ownership before further trial admission`                       | Grader gets the cancellation signal, SIGTERM interrupts after one semantic call, later trial never starts, exit 143; raw candidate response and grader workspace retained; active status interrupted.              |
| `CLI accepts an independent run-state root`                                                                          | Explicit state root receives complete active record linking actual evidence; empty root argument is exit 64.                                                                                                       |
| `CLI ${signal} cancels host work and retains interruption evidence`                                                  | Real SIGINT/SIGTERM after host readiness returns one JSON result with cancelled execution and exit 130/143 respectively; active record is interrupted and evidence exists.                                         |

## Related public CLI and identity acceptance

The [CLI fixture suite](../../tests/cli/fixture-preparation.test.ts) supplies these
end-to-end checks, shared with the CLI parity specification:

| Test title                                                        | Required observation                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLI dry run retains preparation without calling the host`        | Exit 0, `not_run/not_requested/not_assessed`, no checks/metrics, dry execution mode, retained `prepared data\n`.                                                                                                                                             |
| `CLI negotiates and records enforced host instrumentation`        | Enforced supported instrumentation is recorded as requested and applied; passive selection with execution-changing request refuses with exit 64 and null evidence path.                                                                                      |
| `CLI mounts only declared preparation source files`               | Valid source map retains exact prepared bytes; outside mapped file refuses with exit 64/null evidence and containment diagnostic.                                                                                                                            |
| `CLI executes a declared repository fixture`                      | Declared map passes; missing map exits 64. Extension repository fixture plus overlay passes and keeps check order `ready`, `repository-overlay`, `example.extension.ready`.                                                                                  |
| `CLI isolates mapped repository worktrees for ${route} execution` | Shell/native routes see cloned fixture but cannot read primary source, mapped worktree, or sibling worktree. Native candidate, semantic, and advisory routes all obey protection; every check passes, advisory completes, original source bytes stay intact. |
| `CLI accepts generated Git history from a case or extension`      | Both declaration routes pass; generated `.git/config` write refuses with exit 64/null evidence.                                                                                                                                                              |
| `CLI runs shell checks only with explicit isolation roots`        | Missing isolation exits 64. Explicit isolation/protected root passes, including relative CLI protected-root resolution.                                                                                                                                      |

The [preparation validation suite](../../tests/evaluation/preparation-validation.test.ts)
adds pre-candidate/no-results-root checks for relative setup executables, reserved
HOME, unknown environment placeholders, setup on inline fixtures, incomplete
semantic/advisory identities, absent semantic route, advisory on inline fixtures,
advisory exclusions without a reviewer, unavailable graders, duplicated check IDs,
missing shell isolation roots, Git HEAD on inline fixtures, excessive generated
history, source-reference failure, reserved semantic artifact ID, metadata
artifact mount, collisions, Git-excluded artifacts on inline fixtures, and invalid
identity Unicode. Its exact title families are `preparation refuses ${refused.name}
before candidate admission or run allocation`, `refuses ${refusal.name} before
admitting a candidate`, and `refuses ${invalid.name} before candidate execution or
result creation`; individually titled route/artifact cases are preserved there.
Plugin-specific preparation validation belongs to the host/extension parity area.

The [provenance fixture suite](../../tests/fixtures/provenance.test.ts) guards
comparison behavior shared with identity parity:

| Test title                                                                                                         | Required observation                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `unborn Git repositories retain unknown project provenance rather than inventing a revision`                       | Revision and dirty-patch digest remain null; project identity remains a 64-character lowercase hex digest.                  |
| `checkout provenance refuses a nested directory in place of the explicit Git root`                                 | Root records actual revision; nested directory refuses root mismatch.                                                       |
| `non-Git project identity ignores relocation and timestamps but distinguishes executable content`                  | Identical bytes at different paths/times have equal digest; changing executable mode changes digest while bytes stay equal. |
| `package build identity uses declared runtime paths independent of filesystem insertion order and unrelated files` | Reversing insertion order and adding an outside-runtime file do not alter package build digest.                             |

## Port slices and evidence required

These slices can be implemented independently at stable boundaries, with a
failing behavior test first and a passing test after the smallest complete change:

1. Output-check validation and assessment: literal declarations/responses plus
   expected ordered outcomes and first-failure details. Cover missing evidence,
   ECMAScript regex behavior, exact JSON/fences, pointers, subsets, and schema.
2. Artifact preparation and fixture declarations: raw JSON/bytes to validated
   plans, with size/pad-bit/collision positive and negative controls. Then actual
   safe filesystem mounting with independent byte/mode checks.
3. Generated/repository materialization: real Git commands as oracle for stable
   HEAD, staged/untracked state, source immutability, overlays, hooks, executable
   modes, snapshot race, and submodules.
4. Semantic/advisory parsers: bounded serialized responses, complete ID accounting,
   and exact result objects. Integrate separate real host routes only after parser
   behavior is covered; retain failures and raw evidence independently.
5. Ownership and lifecycle: two real processes, a readiness receipt, forced owner
   death, atomic state inspection, cancellation, persistence failure, and expiry.
6. Shell and blind advisory execution: real isolation and Git snapshots on each
   supported OS, process receipts and protected-file controls, followed by CLI
   integration against existing declarations.

Do not replace a missing Rust slice with a narrower passing behavior. Existing
TypeScript integration tests remain reference evidence until corresponding Rust
public-seam tests prove the same effects. Fixtures and host helpers may be reused
as external inputs, but expected values must not call Rust production helpers.
Platform-guarded shell/permission/symlink tests require native macOS and Ubuntu
acceptance; a skipped or unavailable isolation route is not a pass. Current
tests do not establish Windows acceptance. This specification requires fresh
candidate-specific test/CI evidence before any parity claim.
