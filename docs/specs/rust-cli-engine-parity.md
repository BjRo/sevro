# Rust parity: CLI and evaluation engine

This reference records observable behavior the Rust port must preserve from the
TypeScript integration tests at baseline `1400f3f`. It is a migration acceptance
inventory, not evidence that Rust implements the behavior or that these tests
have been run for the port.

Read it alongside the [current contracts](../contracts.md), especially
[results and evidence](../results-v1.md), [saved run settings](../run-settings-v1.md),
[runtime configuration](../runtime-v1.md), [built-in graders](../builtin-graders-v1.md),
[identity](../identity-v1.md), and [extension protocol](../extension-protocol-v1.md).
Those contracts retain their authority. Test-derived constraints below supplement
them; this document does not authorize removing existing CLI forms, adapters,
native routes, formats, or capabilities.

## Scope and evidence

All 29 assigned suites were inspected, including setup and assertions: every
`tests/cli/*.test.ts`, every `tests/evaluation/*.test.ts`, and
`engine.test.ts`, `extension-engine.test.ts`, `preparation.test.ts`,
`cli-concurrency.test.ts`, `main-sync-cli.test.ts`, and
`main-sync-repair-cli.test.ts`. They contain 221 test declarations. Parameterized
tests and loop-generated names cover multiple cases; 221 is not the executed
test count. The inventory below includes every declaration and its expected
observable outcome. Names containing `%s`, `%j`, or template expressions are
the exact source title templates; their input families are described below or
in the corresponding inventory row.

The CLI subprocess, retained result/evidence files, fixture filesystem, extension
exchange, and host request/receipt boundaries are the acceptance seams.
Direct engine tests additionally prove sequencing, cancellation, validation,
and retention behind those seams. Internal TypeScript function layouts are
not requirements for Rust.

## Command admission and output

- Preserve `run`, `report`, `init`, and `demo`, all documented flags,
  `help [command]`, `--help`/`-h`, and `--version`/`-v`.
  Help/version return 0, write no stderr, and create no files. Examples precede
  command/required-option details.
- Ordinary run defaults are one passive trial, threshold 1, jobs 3, project
  root/current-directory path resolution, configuration root equal to project
  root, results under `.sevro/results`, and run-state root equal to results.
  Shell defaults shown in the effective preview are exit 0 and 30,000 ms.
  Native model and effort are explicit per role; they are not inferred.
- A candidate route uses either an injected `--adapter-module` or a native
  `--host`. Semantic and advisory roles have independent adapter/native
  alternatives. Explicit alternatives supplied together are invalid.
  Native executables resolve from PATH or an explicit host binary override,
  and their canonical paths are retained.
- `--json` emits exactly one `sevro.cli-result.v1` document on stdout.
  Effective settings, actual progress, and diagnostics go to stderr.
  Preparation failure still honors the last explicit `--json`/`--no-json`.
  Human output includes aggregate states, per-trial states, failed check
  detail, duration, usage, independent domain outcomes, and evidence location.
  Known zero usage/cost stays zero; missing measurement stays unknown.
- Before-run refusal is exit 64 with execution `not_run`, grading
  `not_requested`, task `not_assessed`, no cases, and null evidence path.
  Admission validation must precede host execution and run storage allocation.
  Missing/unknown flags, extra positional commands, bad paths, malformed cases,
  adapters, manifests and extension selections produce corrective diagnostics.
  Diagnostics name the relevant option/file/field and help where asserted;
  private prompt, response, evaluator error, credential, and source bodies
  must not leak through routine summaries.
- Result states are independent. Passed assessment is exit 0; completed failed
  assessment 1; host execution failure 2; required grader error 3; unavailable
  required evidence 4; internal storage/finalization failure 70; SIGINT 130;
  SIGTERM 143. Dry and prompt-only unassessed success can exit 0.
  The [result contract](../results-v1.md#exit-codes) defines aggregate precedence.
  Finalization retains one output document and preserves an earlier nonzero
  outcome rather than replacing it with a later cleanup failure.
- Progress reflects actual stage entry/completion. Dry mode reports skipped
  candidate/grading; failed execution skips grading. A throwing progress
  observer cannot change assessment or retained evidence.

## Saved selections and identity

`--run-manifest-file` explicitly loads a regular, non-symlink JSON file no larger
than 64 KiB. Its exact root shape is `format: "sevro.run.v1"` and object
`settings`; unknown fields/versions and invalid option value types fail.
Manifest settings cannot contain `json` or another `run-manifest-file`.
Numeric, boolean, nonempty-string and list option types remain distinct.

Resolution order is defaults, manifest, explicit CLI flags. Explicit lists replace
saved lists; an empty saved list selects none. Negative boolean flags override
saved true. Saved paths resolve from the manifest's canonical containing
directory, while explicit paths resolve from invocation cwd. Directory aliases
are canonicalized before resolution and protection checks.

Selecting a CLI adapter replaces a saved native route and its route-only
settings. Selecting the same native host preserves saved model/effort; changing
the candidate host requires fresh explicit model/effort. Grading role selections
remain independent. Selecting a case file replaces saved extension options;
selecting an extension replaces the saved case file. A selected manifest remains
protected even outside project root.

Retain the redacted `sevro.resolved-run-settings.v1` preview separately from
semantic configuration identity. It includes route/operational selections, not
credential paths, private source closure paths, or runtime environment values.
Declared non-secret runtime environment values still belong in runtime policy's
existing redacted evidence. Equivalent saved/explicit native selections yield
the same identity. Model/effort, trials, threshold, jobs, timeout, isolation and
protection changes bind the relevant identity dimension; storage relocation and
presentation do not. Generated run outputs do not perturb project identity.
Capture host configuration before execution so later adapter mutation cannot
make retained configuration disagree with its digest.

## Preparation and fixture safety

Reject malformed cases, duplicate IDs, invalid namespaces, unsupported graders,
empty route identity, relative engine roots, nonpositive or fractional trial/job
counts, nonfinite/zero/above-one thresholds, duplicate required evidence, and
unsupported continuation before admission. CLI canonicalizes relative paths
before passing engine options; direct engine callers require absolute roots.

Inline, generated Git, and mapped repository fixtures remain supported. Generated
history accepts staged overlays; over 128 commits and Git metadata writes are
refused. Repository sources require declared source maps of file URLs contained
in a declared canonical root. Linked primary and sibling worktrees are protected
from candidate and grading access.

Preparation artifacts verify canonical base64 or an explicitly mapped source,
SHA-256, portable contained paths, collision freedom, and boolean
`gitExclude`/`executable`. Reject ancestor/descendant path collisions, traversal,
Git metadata, symlink parents/targets, and source root escapes including symlinks.
Retained bytes/digest/mode survive candidate cleanup; tampered retained artifacts
cannot support a successful result. Excluded preparation files require Git and
must not hide candidate edits.

Trusted fixture setup requires negotiated `sevro.fixture.setup` and a Git fixture.
Validate declarations before executing anything: absolute nonempty argv, at most
16 arguments and 64 KiB aggregate argv, at most 32 environment entries and 16 KiB
environment, no NUL, no reserved HOME, no unknown fields/placeholders. Supported
placeholders remain literal until setup execution. Setup runs before preparation
artifact mounting, with isolated temporary home and default LANG=C when absent.
A setup-created symlink cannot redirect later writes. Setup failure prevents
candidate admission and retains the failed workspace; setup cancellation retains
an explicit interrupted attempt and kills setup work while removing its private
home.

Plugin marketplace/directory and explicit skill invocation declarations require
their negotiated host capabilities, valid nonoverlapping roots, manifests,
declared packaged skills, and Git exclusion. Codex renders packaged
`$plugin:skill` or repository `$skill`; Claude renders packaged
`/plugin:skill` or repository `/skill`. Repository mounts preserve scope.
Invocation must occur exactly once across initial/continuation prompts, and a
Claude repository command must lead its prompt. Only one explicit invocation
declaration may be selected. Workspace placeholders render per distinct trial.

## Execution, grading and advisory review

Each admitted trial gets an independent canonical workspace. Candidate timing
surrounds execution and receipt validation; dry/pre-candidate cancellation has
null duration. Dry preparation retains each trial's prepared artifacts and
identity without calling candidate or graders.

Host receipts are untrusted at their module boundary. Reject malformed entries,
duplicate/reserved/invalid IDs, non-JSON observation data, over 128 observations,
over 32 artifacts, and tested per-item limits above 8 MiB. Invalid receipt
execution fails without accepting raw result/artifact references. Required
complete observations or retained artifacts can satisfy required evidence;
missing/partial required evidence remains unavailable. Explicit
`executionFailed` retains bounded raw evidence but skips grading even if text
looks passing.

Checks preserve declaration order. Shell grading operates on candidate effects
under explicit isolation and records exit metadata plus stdout hash/byte length.
A mismatched exit/output fails assessment; timeout is a grading error.
Semantic grading uses a separate workspace and explicit route. Final-response
and saved-document sources are independent; save the concrete matched document
path. Missing, ambiguous, oversized, unsafe or Git-metadata-alias documents
refuse grading. Absent/partial candidate response skips its semantic grader and
marks unavailable. Semantic verdicts match IDs, not response order; duplicate or
unknown IDs invalidate the entire returned batch without accepting its valid
prefix. A failed semantic host cannot pass through a plausible verdict.

Extensions augment built-ins by default. Explicit advertised replacement removes
only selected built-ins and can remove their otherwise-required grading routes.
Extension results match declared IDs; undeclared/duplicate entries reject the
batch, and omitted required checks remain unavailable. A selected task policy
can replace a failed-check verdict, with its independent recommendation retained,
but cannot override execution failure or missing required evidence. Missing
policy recommendation is grading error. Domain outcomes and metrics remain
separate from task verdict. Changed extension source inputs during execution
refuse assessment with a useful sanitized diagnostic.

Requested/applied instrumentation and actual condition must match the immutable
prepared plan. Execution-changing instrumentation cannot be passive.
Observational instrumentation may be passive. Unsupported/unnegotiated
instrumentation refuses admission; receipt drift produces execution failure.

Advisory review uses a separate blind copy of changed Git fixture content,
including untracked candidate edits and deterministic-check context, with
condition data excluded. It cannot change task verdict or exit code.
Malformed, missing, oversized, thrown or failed-host advisory results are failed
reviews, not passing assessments. Semantic raw verdict retention accepts exactly
1 MiB but not one byte more; advisory raw response accepts exactly 64 KiB but
not one byte more. Accepted and rejected in-bound responses and role-prefixed
trace artifacts retain provenance independently.

## Concurrency, cancellation and retention

- Jobs default to 3; a configured limit bounds live trials. Distinct workspaces
  start with original fixture data; published trial arrays and checkpoints are
  ordered by trial number even when completion order differs.
- Execution or required grading failure closes queued admission promptly.
  Required-grader failure closes it before slow advisory retention finishes.
  Already-active peers drain and retain their completed outcomes. Persistence
  failure also stops queued work, preserves completed peers, retains the failed
  fixture, marks diagnostic ownership, and exits 70.
- SIGINT/SIGTERM stop queued admission, cancel active work, drain cleanup, retain
  previous and partial trials, and finalize interrupted ownership. Cancellation
  before first admission retains an empty interrupted run with no candidate call.
  Cancellation during semantic grading keeps candidate response evidence.
- Equivalent live evaluations are refused before starting a second host.
  Results and active/checkpoint ownership can use separate roots. Run state,
  source repositories, protected peers, ownership metadata, and even peer
  workspaces created after sandbox launch remain hidden under native isolation.
- Persist each completed trial before successful workspace cleanup. Failed,
  cancelled, unavailable-evidence, and failed semantic/advisory workspaces remain
  inspectable. Retain workspace observations and evidence independently.
  Successful permission-locked workspace removal must not follow links or alter
  external target contents/modes.
- Startup removes failed inactive workspaces after 24 hours and preserves their
  saved evidence. Active workspaces, missing/unreadable/malformed/oversized or
  insecure/symlink ownership records, and unverifiable owners are preserved.
  Remove expired ownership records for already-deleted workspaces; tolerate
  concurrent cleanup of the same expired workspace.
- Ownership initialization failure unwinds newly allocated result/state
  directories without touching pre-existing blocking files.
- CLI result/latest publication replaces a symlink itself, leaving its target
  untouched. A publication failure becomes 70 after an otherwise successful run;
  prior task failure retains exit 1 and its original result.

## Native routing and user workflows

Codex imports only its supported agent concurrency setting from the separate
configuration root. Missing/empty unrelated configuration yields null limit;
dangling links, malformed TOML, invalid positive-integer limits and unusable
roots fail before execution. All selected Codex roles retain the same selected
limit and canonical executable. Timeout works for exec and app-server, defaults
remain accepted, maximum is 1,800,000 ms, and invalid/over-limit values refuse
admission.

App-server native goals retain status and actual feedback-boundary facts without
objective text. Native continuation can complete after one client turn without
the runner inventing another turn. Goal readback works without update
notifications. Fatal native errors and time bounds retain partial failure
evidence and cannot pass.

Claude continuation resumes the same isolated session/configuration/model/effort,
grades the final turn, retains initial/follow-up events, and aggregates only
bound usage. Failed, missing, foreign-session and duplicate terminal results
fail execution and prevent grading; failed initial turns do not resume.
Unknown pre-follow-up worktree state and incomplete usage remain explicit.
Curated candidate/shell runtimes remove inherited DARROW_CACHE_DIR, use a curated
UV cache/offline mode, and give candidate and shell distinct private homes.

Response and coding initializers generate runnable positive and real negative
controls. Repository-skill templates mount actual skills and require explicit
native prerequisites; synthetic receipt tests prove check behavior, not native
skill selection. Existing paths/aliases are never overwritten. Demo owns its
inputs independently of caller runtime configuration. Reports can use latest
results or relative result paths and reject canonical duplicates/ambiguous input.

## Verification limits and first slices

This is source inspection only; no suite pass or Rust parity is claimed.
Some native tests return early when isolation tools or Codex are unavailable;
one concurrent future-peer sandbox scenario explicitly runs only on macOS.
Retain those guards as visibility limits, not as proof of cross-platform parity.
These suites use deterministic native wrappers and injected adapters; they do
not establish authenticated model quality, real service behavior, or Windows
acceptance. Exact timeout boundary coverage is limited to the named values;
retention tests prove just-before/just-after 24 hours, not every clock failure.

The exhaustive inventory below is exhaustive only for this assigned scope.
Other migration specifications must cover the remaining report, identity,
schema, runtime, native-host, isolation, extension-transport, packaging and
quality-tooling suites. Preserve broader contract obligations absent here,
including aggregate multi-case precedence, artifact aggregate byte budgets and
native diagnostic/transcript limits. Missing tests are not permission to remove
a feature. Language/module adapter compatibility needs an implementation design
and process-level oracle; these tests require current adapter-module behavior.

Useful first TDD slices, each completed through its public seam before extending:

1. Rust CLI help/version and invalid invocation: exact streams, exits and
   zero filesystem effects, then case/manifest validation diagnostics.
2. One inline fixture through the existing injected-adapter route, output check,
   versioned JSON/evidence, atomic retention and successful cleanup; add failing
   and missing-response controls before adding trial scheduling.
3. Saved manifest resolution, independent route choices and redacted preview,
   with equivalent explicit/saved identity and storage-relocation controls.
4. Sequential multi-trial threshold and cancellation retention, then jobs-limited
   scheduling with out-of-order completion and stop-admission fault controls.
5. Extension prepare/execute/evaluate with real JSONL peer, source stability,
   complete required evidence and policy/replacement negative controls.
6. Generated/mapped Git fixtures, isolated shell grading, semantic document
   sources and independent advisory review, followed by native Codex/Claude
   routes and all continuation/goal/artifact behavior.

These are ordering suggestions, not a narrowed definition of the completed port.
Every inventory obligation and the other domains remain required.

## Exact test inventory

Each table links to the inspected suite. The source title is exact, including
parameter placeholders. Expected outcomes summarize assertions and do not assert
that the tests have been executed. Counts are declarations, not expanded runs.

### [tests/cli/case-validation.test.ts](../../tests/cli/case-validation.test.ts)

| Exact source test title                                                                           | Expected observable outcome                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI rejects malformed case %s before host execution or run storage`                              | All 16 malformed case variants fail 64 before host/storage: empty ID/prompt, blank/nonstring continuation, null/array/unknown/malformed fixture, unsafe generated paths, invalid checks/configuration and required evidence. |
| `CLI refuses malformed adapter %s at its public module boundary`                                  | Invalid adapter ID/model/effort/run/instrumentation and capability type/namespace/duplication fail 64 with no run allocation.                                                                                                |
| `public CLI %s during trusted fixture setup retains a cancelled trial before candidate admission` | SIGINT/SIGTERM during setup return 130/143, cancelled/unassessed; candidate never starts, setup PID stops, LANG defaults C, fixture remains, private home is removed, checkpoint contains one trial and interrupted owner.   |
| `CLI refuses invalid --%s=%s before input loading or host execution`                              | Invalid condition/threshold/digest, misplaced extension/source options, unqualified policy/replacement, incompatible native options, unsupported host and protected roots without isolation fail before input loading.       |
| `CLI refuses extension command %s before negotiation or storage`                                  | Malformed JSON, object/null/empty argv, relative executable, nonstring/empty argument fail 64 before negotiation/storage.                                                                                                    |
| `CLI refuses invalid extension %s before negotiation or storage`                                  | Private/redacted configurations must both parse as JSON objects; arrays/null/malformed JSON fail 64 with contextual diagnostics.                                                                                             |
| `CLI refuses an unresolved extension case before host execution or storage`                       | Unresolved extension case fails 64 with empty cases, null evidence, and no results directory.                                                                                                                                |
| `CLI human output retains extension domain outcomes independently of task verdict`                | Human task pass and failed domain outcome coexist; exact stage order goes to stderr and retained evidence exists.                                                                                                            |
| `CLI refuses malformed source maps before admission %s`                                           | Null/array source map, foreign URL and nonstring URL fail 64 before storage; map must contain file URLs.                                                                                                                     |

### [tests/cli/claude-continuation.test.ts](../../tests/cli/claude-continuation.test.ts)

| Exact source test title                                                               | Expected observable outcome                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI resumes Claude in the same isolated session and grades its final turn`           | One initial launch then resume uses same session; grade ready final turn; initial/follow-up events remain; complete continuation reports unchanged worktree and aggregates 4/6 tokens, $0.03.     |
| `Claude continuation never grades failed or unbound native results: %s`               | Failed/missing/foreign/duplicate initial or follow-up result returns 2, failed execution, no checks, retained events; initial failure stops resume; follow-up failure makes continuation partial. |
| `CLI leaves Claude usage unmeasured when a resumed result belongs to another session` | Foreign resumed session leaves tokens/cost null and usage incomplete while returning 2/unassessed.                                                                                                |
| `Claude continuation keeps workspace and usage uncertainty explicit`                  | Changed worktree is false, unmeasurable worktree null/partial; incomplete resumed usage leaves tokens null and complete=false but retains measured $0.03; valid final result still passes.        |

### [tests/cli/claude-runtime.test.ts](../../tests/cli/claude-runtime.test.ts)

| Exact source test title                                        | Expected observable outcome                                                                                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI curated Claude runtime leaves repository caches to tools` | Curated Claude receives isolated HOME under fixture Git metadata, no inherited DARROW_CACHE_DIR, readable UV cache, UV_OFFLINE=1 and PYTHONDONTWRITEBYTECODE=1; assessment passes. |
| `CLI curated shell grading leaves repository caches to tools`  | Shell uses separate HOME from candidate, no inherited Darrow cache, curated offline UV cache; tools may write home cache without dirtying Git; shell check passes.                 |
| `CLI runs its bundled Claude route with isolated credentials`  | Bundled Claude reads copied isolated credentials, returns passing result and retains native route/model; simultaneous injected/native route fails 64.                              |

### [tests/cli/codex-configuration.test.ts](../../tests/cli/codex-configuration.test.ts)

| Exact source test title                                                       | Expected observable outcome                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI imports only the Codex limit from its separate configuration root`       | Separate config root supplies only agent limit (7), not unrelated model text or project limit (3); retained canonical executable/limit; changing limit to 9 alters identity. |
| `CLI isolates a separate configuration repository and its linked worktree`    | Shell grading cannot read separate configuration repository or linked worktree; protected source contents remain unchanged.                                                  |
| `CLI refuses a dangling Codex configuration link before execution`            | Dangling config.toml link fails 64/not_run with Cannot read Codex configuration.                                                                                             |
| `CLI distinguishes absent Codex configuration from a dangling directory link` | Missing .codex or config file is valid with null limit; dangling directory link fails 64 and names config path.                                                              |
| `CLI rejects an explicitly empty configuration root`                          | Both empty --config-root value forms fail 64/not_run.                                                                                                                        |
| `CLI retains Codex defaults and the configured limit for every role`          | Candidate/semantic/advisory each retain canonical executable and limit 8 or null for absent/empty/unrelated config; dry remains unassessed.                                  |
| `CLI rejects malformed Codex settings and unusable configuration roots`       | Malformed TOML, scalar agents and zero/negative/fractional/float/string/bool/unsafe integer limit fail 64 naming config; directory config and unusable roots fail.           |

### [tests/cli/codex-route.test.ts](../../tests/cli/codex-route.test.ts)

| Exact source test title                                         | Expected observable outcome                                                                                                                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI runs its bundled Codex route with explicit auth and model` | Explicit native auth/model route passes, retains candidate role, supports separate semantic/advisory Codex roles and prefixed artifacts; advisory fail leaves task pass; conflicting native/adapter choices fail 64. |

### [tests/cli/defaults.test.ts](../../tests/cli/defaults.test.ts)

| Exact source test title                                                                           | Expected observable outcome                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ordinary run defaults assess one passive trial with all trials required to pass`                 | Default run passes one passive trial, threshold 1, jobs 3; evidence lives under cwd/.sevro/results.                                                  |
| `selected %s host resolves PATH once and retains the executable with an explicit override`        | Codex/Claude binary resolves PATH and explicit relative override once; canonical executable retained even in dry run.                                |
| `relative CLI paths resolve from cwd through symlinks before runtime protection checks`           | Cwd-relative paths canonicalize symlinks before protection: overlapping runtime read root fails 64; valid selection passes.                          |
| `built-in demo owns its inputs and reports an assessed verdict from an unrelated cwd`             | Demo ignores unrelated caller runtime file and dangling link, assesses pass in human/JSON modes, retains evidence under caller .sevro/results.       |
| `project-local results leave project identity stable while source changes alter it (Git=%s)`      | Repeated project-local results preserve project/dirty identity with or without Git; meaningful source mutation changes project digest.               |
| `effective settings are visible on stderr before the candidate starts without contaminating JSON` | Effective settings stderr precedes candidate; stdout one JSON line; preview records passive/1/1/3, resolved roots and shell defaults exit 0/30000ms. |
| `missing selected %s binary names PATH and its explicit override before execution`                | Missing Codex/Claude binary fails 64 with PATH and --<host>-bin recovery hint, null evidence and unassessed task.                                    |
| `demo rejects unsupported settings as a configuration failure without an assessment`              | demo --host codex fails 64 with only --json accepted, no evidence or assessment.                                                                     |
| `demo reports an unusable TMPDIR as one actionable runner failure result`                         | Unusable TMPDIR returns one JSON result, 70/unassessed/null evidence, actionable writable-directory diagnostic.                                      |
| `CLI finalization preserves one result and the earlier failure (%j)`                              | Cleanup failure converts pass to 70 but preserves preceding task failure 1 or configuration failure 64; exactly one result and cleanup diagnostic.   |

### [tests/cli/diagnostics.test.ts](../../tests/cli/diagnostics.test.ts)

| Exact source test title                                      | Expected observable outcome                                                                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI explains parser failures on stderr (JSON=%s)`           | Missing results-root argument returns 64; stderr names option, argument and run help; JSON has invocation.invalid/null evidence/empty cases, human stdout only unassessed states. |
| `CLI gives corrective values for --%s`                       | Invalid condition, threshold, trials, empty project-root and unknown option return 64 with option-specific corrective values and help.                                            |
| `CLI explains runner storage failures on stderr (JSON=%s)`   | Results root occupied by file returns 70 with writable-root repair hint; JSON runner.error or human unassessed states.                                                            |
| `CLI locates invalid case %s in its source file`             | Invalid prompt/continuation/fixture/inline content/check/configuration/required evidence returns 64 naming source file and exact field plus correction.                           |
| `CLI locates an unreadable case: %s`                         | Missing/malformed case names file, --case-file and readable JSON requirement, returns 64.                                                                                         |
| `CLI identifies a missing host adapter and how to repair it` | Missing adapter returns 64 naming module path, option and exists/imports recovery; cases empty.                                                                                   |

### [tests/cli/extension.test.ts](../../tests/cli/extension.test.ts)

| Exact source test title                                                         | Expected observable outcome                                                                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI resolves an explicit extension case and retains extension evidence`        | Explicit case yields built-in plus extension checks, negotiated identity and score; missing case or simultaneous case-file fails 64.                                       |
| `CLI reports when declared extension source changes during candidate execution` | Mid-run source mutation returns 3/completed/error/unassessed; retains prior built-in pass; same sanitized actionable message in CLI/evidence, private source path omitted. |
| `CLI sanitizes unknown extension grading failures`                              | Unknown private grading failure returns generic grader.error/extension grading did not complete; private evaluator marker/path absent from output and evidence.            |
| `CLI supplies the selected candidate route during extension resolution`         | Resolve receives selected host ID/model/effort/capabilities and records negotiated sevro.case.host-route.                                                                  |
| `CLI retains redacted extension configuration with its identity`                | Only redacted extension configuration retained; its digest matches extension identity, private marker absent.                                                              |
| `CLI text output names domain outcomes apart from the task verdict`             | Human output keeps passed task separate from failed domain outcome.                                                                                                        |
| `CLI selects an advertised extension task policy explicitly`                    | Explicit advertised policy changes default failure to pass while failed check remains; recommendation/replacement identity retained; policy without extension fails 64.    |
| `CLI replaces a selected built-in grader through the extension`                 | Selected sevro.regex replacement removes only that built-in check; evidence records replacement; unsupported or repeated replacement fails 64.                             |

### [tests/cli/fixture-preparation.test.ts](../../tests/cli/fixture-preparation.test.ts)

| Exact source test title                                           | Expected observable outcome                                                                                                                                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI dry run retains preparation without calling the host`        | Dry extension preparation returns 0/not_run/not_requested/not_assessed, no checks/metrics, retained prepared bytes and dry execution mode without host call.                            |
| `CLI negotiates and records enforced host instrumentation`        | Enforced requested/applied instrumentation matches in evidence; requesting execution-changing instrumentation under passive fails 64 before run.                                        |
| `CLI mounts only declared preparation source files`               | Declared contained source bytes mount and retain; mapped path outside declared root fails 64/null evidence.                                                                             |
| `CLI executes a declared repository fixture`                      | Mapped repository fixture passes; missing map fails 64; extension repository overlay plus built-in/extension checks passes.                                                             |
| `CLI isolates mapped repository worktrees for ${route} execution` | Shell/native candidate, semantic and advisory cannot read primary, mapped or sibling source worktrees; all checks pass and source bytes remain original (guarded native prerequisites). |
| `CLI accepts generated Git history from a case or extension`      | Generated Git history and staged overlay work via direct case or extension; .git/config commit entry fails 64/null evidence.                                                            |
| `CLI runs shell checks only with explicit isolation roots`        | Shell check without isolation fails 64; explicit isolation/protected roots pass with absolute or cwd-relative roots.                                                                    |

### [tests/cli/help.test.ts](../../tests/cli/help.test.ts)

| Exact source test title                                                       | Expected observable outcome                                                                                                                                       |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI top-level help %j leads with common examples without preparing a run`    | Empty argv, --help, -h and help: 0, stderr empty, no created files; Usage, common run/report examples before Commands, run-help/version discoverability.          |
| `CLI run help %j explains required options and defaults`                      | run --help/-h and help run: examples precede Required, documented option names/default jobs 3/config-root/run-state-root/cwd-relative paths/dry/json, no effects. |
| `CLI report help %j gives an example, required inputs and output default`     | report help aliases show examples before Required, --result-file, absolute path wording, Markdown default and sevro.report.v1; no effects.                        |
| `CLI version %j reports the installed package version without a run`          | --version/-v prints exactly sevro <package version> plus newline; 0, empty stderr and no files.                                                                   |
| `CLI init help %j explains safe templates without writing files`              | init help aliases show response\|repository-skill\|coding, overwrite refusal, --codex-auth-file and report --latest; no effects.                                  |
| `CLI demo help %j explains owned inputs and evidence without preparing a run` | demo help aliases show Usage: sevro demo [--json], .sevro/results and no-model-credential description; no effects.                                                |

### [tests/cli/identity.test.ts](../../tests/cli/identity.test.ts)

| Exact source test title                                              | Expected observable outcome                                                                                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI derives stable build and project digests without caller inputs` | Automatic runner/project SHA-256 digests are stable across repeated runs; runner digest equals identity dimension; malformed supplied digest fails 64.    |
| `CLI records an explicitly selected local runner checkout`           | Selected running checkout retains checkout source, supplied build digest, revision and optional dirty digest; mismatching checkout subdirectory fails 64. |

### [tests/cli/invocation-validation.test.ts](../../tests/cli/invocation-validation.test.ts)

| Exact source test title                                          | Expected observable outcome                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI reports invalid invocation as versioned JSON without a run` | Missing case and bad digest produce versioned not_run/not_requested/not_assessed result, exit 64, null evidence and no cases.                                                                     |
| `CLI refuses %s before run admission`                            | Wrong-route Codex timeout, unknown/missing options, positional command, missing/empty source closure and unpaired private/redacted configuration fail 64 before admission with named diagnostics. |

### [tests/cli/results.test.ts](../../tests/cli/results.test.ts)

| Exact source test title                                                | Expected observable outcome                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI emits one JSON result and uses the task exit category`            | Pass returns 0/passed, one JSON result equal retained result; stderr ordered preparation/candidate/grading/evidence progress. Failed assessment returns 1/completed/completed/failed. |
| `CLI reports unavailable required host evidence`                       | Required host evidence absent returns 4/completed/unavailable/unassessed; complete observation passes with source/completeness retained.                                              |
| `CLI runs semantic checks through an explicit grader route`            | Semantic checks require explicit route (64 if absent); retain candidate/semantic routes and passed check; failed verdict exits 1, malformed verdict 3.                                |
| `CLI selects an advisory route and retains its independent assessment` | Advisory fail assessment stays independent of passing task; route/review retained and identity differs without it; conflicting route or exclusions without host fail 64.              |

### [tests/cli/run-manifest.test.ts](../../tests/cli/run-manifest.test.ts)

| Exact source test title                                                                                     | Expected observable outcome                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `saved settings replace defaults, repeat unchanged, and explicit flags replace saved settings`              | Saved trials=2/jobs=1/threshold=.5 override defaults; repeat identity stable; explicit 1/3/1 overrides and changes identity; resolved preview retains manifest selection.                              |
| `manifest paths use its directory while CLI paths use cwd and storage relocation preserves identity`        | Saved paths resolve from manifest directory, explicit from cwd; equivalent selections and output-root relocation preserve evaluation digest.                                                           |
| `a manifest directory alias resolves saved paths from its canonical target`                                 | Manifest directory symlink resolves to canonical target before relative saved paths; retain canonical manifest/case/project paths.                                                                     |
| `negative boolean flags override saved true without leaving an unassessed dry run`                          | --no-dry and --no-shell-isolation replace saved true, yield assessed pass and false preview fields.                                                                                                    |
| `saved empty optional lists select no entries for an ordinary case`                                         | Empty saved repeatable lists select none for ordinary case and are retained as zero/empty selections.                                                                                                  |
| `saved native candidate and grading roles retain explicit choices and bind semantic overrides`              | All three native roles retain independently explicit model/effort; private auth absent from preview/evidence; model/semantic effort/timeout changes route/configuration identity.                      |
| `explicit routes replace saved alternatives and repeated lists replace instead of append`                   | Explicit adapters replace saved native alternatives per role; explicit advisory list replaces saved list; --no-dry executes and retains completed review.                                              |
| `a saved assessment selection independently affects identity (%j)`                                          | Each candidate/semantic/advisory model/effort, trial count, threshold, jobs, timeout, isolation and protected root override changes its corresponding identity dimension.                              |
| `manifest native routes reproduce equivalent explicit selections`                                           | Equivalent full explicit native configuration equals manifest identity.                                                                                                                                |
| `selecting the same saved native host preserves its model and effort`                                       | Re-selecting same native host keeps saved model/effort and identical digest.                                                                                                                           |
| `native routes replace saved adapters independently and retain saved grading model choices`                 | Explicit native alternatives remove saved adapters independently while keeping saved semantic/advisory model/effort.                                                                                   |
| `explicit false removes saved native diagnostics and Claude project-settings authority`                     | Negative diagnostics/project-settings flags remove saved authority; resolved false values and changed semantic configuration digest.                                                                   |
| `saved native routes require an explicit %s instead of inferring another role's choice`                     | Every native role requires its own model and effort; each missing field fails 64 with missing --<field>, no inferred choice.                                                                           |
| `switching native candidate host requires fresh model and effort while retaining grading selection`         | Switching Codex candidate to Claude without fresh model fails 64; supplying model/effort succeeds and preserves separate grading selection.                                                            |
| `CLI source selection replaces saved extension settings and can select an extension from a saved JSON case` | CLI case-file clears saved extension/policy/replacements; explicit extension clears saved case and replaces source list; preview reports count without private source paths.                           |
| `runtime configuration remains separate and runtime environment is omitted from resolved settings`          | Explicit runtime-config path retained, runtime environment value omitted from resolved/stderr but retained in runtime policy's redacted evidence.                                                      |
| `a saved manifest outside the project stays protected from runtime read grants`                             | Runtime grant overlapping an external saved manifest via alias fails 64, remains unassessed.                                                                                                           |
| `invalid manifest %j reports field %s as one unassessed JSON result`                                        | Null/array root, wrong version, missing settings, unknown fields and wrong option types/blank values/list items/json/nested manifest fail 64 naming file and field, one unassessed JSON/null evidence. |
| `unusable %s manifest keeps JSON failure output and actionable file context`                                | Missing, syntax-invalid, >64KiB, symlink and directory manifests fail 64 with option/file context and no raw malformed-body leak.                                                                      |
| `a valid manifest with a later missing input preserves the JSON error contract`                             | Valid manifest referencing absent case retains one unassessed JSON error with 64 and missing-file context.                                                                                             |
| `preparation failures honor the last explicit JSON boolean (%j)`                                            | Last explicit --json/--no-json wins even when manifest loading fails, with correct JSON or human output.                                                                                               |

### [tests/cli/trial-retention.test.ts](../../tests/cli/trial-retention.test.ts)

| Exact source test title                                             | Expected observable outcome                                                                                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI supplies a canonical candidate workspace`                      | Candidate workspace string equals realpath, retained observation proves canonical path.                                                                          |
| `CLI removes a permission-locked candidate directory (%s)`          | Successful locked child/root/readable-root directories are removed; linked external target bytes and permission modes remain unchanged; saved result equals CLI. |
| `CLI accepts an independent run-state root`                         | Independent run-state root has complete active record referencing results evidence; empty root fails 64.                                                         |
| `CLI ${signal} cancels host work and retains interruption evidence` | SIGINT/SIGTERM cooperatively cancels host, returns 130/143, cancelled result, interrupted active record and retained evidence.                                   |

### [tests/cli/workflow.test.ts](../../tests/cli/workflow.test.ts)

| Exact source test title                                                                                           | Expected observable outcome                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `response initializer creates an assessed project with a real negative control and refuses overwrites`            | Response template prints dry-run command, positive passes, negative fails, evidence under new project; duplicate target refused 64 without overwriting case.                        |
| `coding initializer grades the edited code with positive and negative input assertions`                           | Coding template grades actual edit via addition check; positive passes/0, negative fails/1.                                                                                         |
| `repository skill initializer prepares the actual mount and requires explicit native prerequisites`               | Repository skill template requires native auth; explicit dry prerequisites yield not_run/unassessed with mounted startup-skill artifact and documented unexecuted model limitation. |
| `progress follows actual candidate execution on stderr while JSON stays one document`                             | Candidate-start progress precedes actual host call; grading follows; dry emits skipped stages, no host call and unassessed result.                                                  |
| `completion shows trial failures and measured duration and latest supports relative paths`                        | Human failure shows trial/check detail, measured duration and unknown usage; report --latest and relative result files work; dry duration/task remain unknown/unassessed.           |
| `latest publication replaces a symlink without touching its target and preserves failure precedence`              | latest.json symlink replaced without touching target; blocked publication preserves prior task failure 1, but turns otherwise passing run into 70/unassessed.                       |
| `throwing progress observers cannot change assessment or retained evidence`                                       | Throwing progress callback is observed but cannot change passing assessment or equality of saved/result document.                                                                   |
| `repository skill template assertions accept the fixture answer and reject a wrong port with a synthetic receipt` | Synthetic repository skill receipt with correct command/port passes; wrong port fails while command check stays passed; native selection not established.                           |
| `failed execution skips grading and keeps private prompts and response bodies out of human summaries`             | Thrown candidate failure returns 2 and skipped grading; private prompt/error body absent from stdout/stderr.                                                                        |
| `completion displays known zero usage and cost separately from unknown measurements`                              | Measured zero input/cost display as 0/$0.0000, output 7, measured duration; report preserves zeros.                                                                                 |
| `init refuses directory aliases without touching user content and report detects canonical duplicate inputs`      | Initializer refuses directory alias without touching target; report rejects canonical duplicate result paths; relocated --latest root succeeds.                                     |
| `workflow refuses ambiguous or empty input %j`                                                                    | Unknown/positional/empty init input, latest plus result-file, results-root without latest and empty result-file return 64 with nonempty stderr and empty stdout.                    |

### [tests/evaluation/advisory-failures.test.ts](../../tests/evaluation/advisory-failures.test.ts)

| Exact source test title                                                     | Expected observable outcome                                                                                                                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records a failed advisory host without accepting its passing assessment`   | executionFailed advisory host cannot supply passing assessment: review failed/null, raw response and prefixed trace retained, review workspace retained, task pass/exit 0 unchanged.         |
| `advisory review bounds raw response retention for ${response.name} output` | Absent or >64KiB advisory response is failed/null with no raw ref; exactly 64KiB is accepted/retained with matching hash/path; traces always retained and failed review workspace preserved. |

### [tests/evaluation/extension-grading.test.ts](../../tests/evaluation/extension-grading.test.ts)

| Exact source test title                                                                                                                        | Expected observable outcome                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension grading can assess complete host observations when the optional final message is absent`                                            | Complete host observation can support extension assessment despite null optional final message: completed/completed/passed/0, raw path null and final-message completeness unavailable. |
| `extension grading retains a failed check without inventing detail or evidence`                                                                | Failed extension check with empty detail/refs stays failed/1 with no invented detail or evidence.                                                                                       |
| `extension grading associates two reversed results with their declared criteria`                                                               | Reversed response IDs are associated by declaration and emitted in declared order with correct status/detail; one failure yields 1.                                                     |
| `extension grading refuses a valid prefix followed by ${suffix === "first" ? "a duplicate" : "an undeclared"} ID without accepting the prefix` | Duplicate or undeclared later ID invalidates entire extension batch, including valid prefix: error/unassessed/3, no checks/domain outcomes, sanitized grader diagnostic.                |
| `retains an undeclared extension check as a grading error without assessing it`                                                                | Undeclared extension check produces grading error/3/unassessed with retained evidence.                                                                                                  |

### [tests/evaluation/fixture-setup-validation.test.ts](../../tests/evaluation/fixture-setup-validation.test.ts)

| Exact source test title                                                                                | Expected observable outcome                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixture setup validation preserves declared argv and environment placeholders without executing them` | Valid argv/placeholders preserved without execution; missing environment becomes empty object; absent setup becomes null.                                                           |
| `fixture setup validation refuses ${invalid.name} at its unknown-input boundary`                       | Reject null/array/scalar declaration, empty/nonstring/>16/oversize/NUL argv, array/scalar/>32/oversize/NUL environment, and undeclared top-level field with named validation error. |

### [tests/evaluation/host-evidence.test.ts](../../tests/evaluation/host-evidence.test.ts)

| Exact source test title                                                                                        | Expected observable outcome                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retained host configuration digest stays coherent when an adapter updates its configuration during execution` | Adapter mutation after admission does not alter retained initial host configuration; configuration digest equals identity configuration dimension.                                                                                                                               |
| `refuses applied instrumentation changed by an adapter from the prepared request`                              | Mutating requested instrumentation in host call fails execution/2/unassessed; retained requested plan stays enabled=true.                                                                                                                                                        |
| `rejects ${receipt.name} without assessing the candidate`                                                      | All 13 malformed receipt families fail 2/unassessed: nonobject observations/artifacts, >8MiB text/data/artifact, non-JSON data, collision/reserved/invalid/duplicate IDs, >128 observations/>32 artifacts; one trial, null raw path, unavailable completeness, no artifact refs. |

### [tests/evaluation/preparation-validation.test.ts](../../tests/evaluation/preparation-validation.test.ts)

| Exact source test title                                                                                              | Expected observable outcome                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preparation refuses ${refused.name} before candidate admission or run allocation`                                   | Relative setup executable, reserved HOME, unknown environment placeholder and setup on inline fixture refuse configuration before candidate calls/results allocation.                                                                                                                                                                                                                 |
| `preparation refuses an incomplete advisory route before candidate admission or run allocation`                      | Incomplete advisory route identity refuses configuration before candidate/results allocation.                                                                                                                                                                                                                                                                                         |
| `preparation refuses a check from an unadvertised extension grader before candidate admission or run allocation`     | Unadvertised extension grader refuses configuration before candidate/results allocation.                                                                                                                                                                                                                                                                                              |
| `preparation refuses an undeclared skill invocation placeholder before candidate admission or run allocation`        | Skill invocation placeholder without declaration refuses before candidate/results allocation.                                                                                                                                                                                                                                                                                         |
| `package preparation refuses ${refusal.name} with contextual cause before candidate admission`                       | Duplicate/nested Claude plugin roots and invalid marketplace/duplicate plugin names refuse before admission with contextual error and retained cause.                                                                                                                                                                                                                                 |
| `package preparation refuses ${refusal.name} before candidate admission`                                             | Codex invocation without marketplace/unselected plugin, Claude use of Codex placeholder, or missing packaged skill refuses before admission.                                                                                                                                                                                                                                          |
| `preparation refuses an artifact using the semantic grader evidence ID before candidate admission or run allocation` | Preparation artifact using sevro.semantic.verdicts when semantic grading selected is refused before allocation.                                                                                                                                                                                                                                                                       |
| `preparation refuses an artifact targeting Git metadata before candidate admission or run allocation`                | Preparation artifact targeting .git/config refused before allocation.                                                                                                                                                                                                                                                                                                                 |
| `preparation refuses unpaired Unicode in ${location} with identity context before candidate admission`               | Unpaired Unicode in host configuration or fixture bytes fails invalid identity inputs before allocation.                                                                                                                                                                                                                                                                              |
| `refuses a selected case that diverges from the extension-resolved declaration`                                      | Exact extension-resolved case runs; changing selected prompt causes resolved/selected mismatch refusal.                                                                                                                                                                                                                                                                               |
| `refuses ${refusal.name} before admitting a candidate`                                                               | Git-excluded artifact on inline fixture or collision with fixture content refuses before host/results allocation.                                                                                                                                                                                                                                                                     |
| `refuses ${invalid.name} before candidate execution or result creation`                                              | All 27 invalid plans refuse before host/storage: unreadable/relative roots, unsupported/blank continuation, >128 commits/metadata writes/undeclared repository, absent/incomplete semantic or advisory route, invalid advisory fixture/exclusions, duplicate/unknown checks, missing shell isolation, Git HEAD on inline, empty identity, invalid trials/jobs/threshold/evidence IDs. |

### [tests/evaluation/semantic-grading-failures.test.ts](../../tests/evaluation/semantic-grading-failures.test.ts)

| Exact source test title                                                                                                                | Expected observable outcome                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `semantic grading associates two reversed verdicts with their declared criteria`                                                       | Reversed verdict IDs map to declared checks and preserve reason; fail/1 aggregate; original verdict document retained unchanged.                                                            |
| `semantic grading refuses a valid prefix followed by ${id === "first" ? "a duplicate" : "an unknown"} ID without accepting the prefix` | Unknown/duplicate later ID rejects complete batch including valid prefix; error/3/unassessed, no verdict observations/checks, sanitized diagnostic, original raw verdict artifact retained. |
| `keeps semantic grading unavailable for a ${candidate.name} candidate without calling the grader`                                      | Absent/partial candidate response never calls semantic host; unavailable check with empty evidence, completed/unavailable/unassessed/4.                                                     |
| `refuses a failed semantic host even when its output contains a passing verdict`                                                       | executionFailed semantic host cannot pass via valid-looking verdict; error/3/unassessed and raw verdict plus prefixed trace retained.                                                       |
| `semantic grading bounds raw verdict retention for ${response.name} output`                                                            | Exactly 1MiB verdict accepted/retained; absent or above limit yields error/3/no accepted checks/no raw ref. Trace retained; failed grader workspace retained.                               |
| `retains ${grader.name} semantic output and its workspace for grading-error inspection`                                                | Malformed/incomplete semantic output returns error/3/unassessed and retains original output plus grader workspace.                                                                          |
| `refuses ${artifact.name} semantic documents without calling the grader`                                                               | Missing, ambiguous or >64KiB saved document skips grader and yields error/3/unassessed while retaining candidate response.                                                                  |

### [tests/evaluation/trial-retention.test.ts](../../tests/evaluation/trial-retention.test.ts)

| Exact source test title                                                                                              | Expected observable outcome                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `active trusted fixture setup cancellation retains an interrupted unassessed run before candidate admission`         | Active setup cancellation calls no candidate; cancelled/not_requested/unassessed/130 and interruption retained in run evidence.                                                |
| `fixture setup interruption retains a prior completed trial and one cancelled partial attempt`                       | Second setup interruption after first pass retains two ordered trial states: completed/pass then cancelled/unassessed; first raw ready remains, second duration/raw path null. |
| `ordinary trusted fixture setup failure stays a failure before candidate admission`                                  | Setup process exit 7 throws fixture setup failed (7), candidate never starts, no cancellation signal invented; failed baseline workspace remains.                              |
| `ownership initialization failure removes separately allocated run and state directories before candidate admission` | Failed owners initialization removes allocated result run and state run directories, preserves original owners blocking file and locks directory, never calls candidate.       |
| `retains a failed host's raw response and artifacts before fixture cleanup`                                          | Failed host retains raw ready, trace bytes/hash and complete observation while task unassessed/checks empty; failed candidate workspace remains.                               |
| `retains semantic-phase cancellation and interrupted ownership before further trial admission`                       | Semantic SIGTERM cancellation returns 143/cancelled/unassessed, stops further trial admission, retains semantic workspace/candidate raw response and interrupted owner.        |

### [tests/engine.test.ts](../../tests/engine.test.ts)

| Exact source test title                                                                   | Expected observable outcome                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runs trials, applies threshold, and retains evidence before fixture cleanup`             | Two trials pass/fail meet .5 threshold and aggregate passed/0; each evidence saved before cleanup, successful workspace removed and failed retained; runner checkout provenance/unknown usage/nonnegative durations retained.                    |
| `renders the workspace token separately for each trial`                                   | Every workspace token renders with that trial's unique workspace; two host calls see distinct paths.                                                                                                                                             |
| `routes a rendered continuation only to a capable host`                                   | Initial/follow-up workspace tokens render correctly; continuation reaches capable host once and unsupported host rejects.                                                                                                                        |
| `dry preparation records every trial without executing the host`                          | Two dry trials call no host, produce not_run/not_requested/unassessed/0 with null duration/raw paths, and identity differs from execution.                                                                                                       |
| `required host observations fail closed when missing or incomplete`                       | Complete required observation passes with host source; missing/partial yields unavailable/4; reserved final-message observation ID fails execution.                                                                                              |
| `host artifacts are retained per trial and can satisfy required evidence`                 | Per-trial host artifact paths/bytes distinct and satisfy required evidence; absent artifact unavailable/4; traversal ID fails execution.                                                                                                         |
| `semantic checks use an isolated grader route and retain verdict evidence`                | Separate semantic workspace lacks candidate fixture files; explicit route/verdict observations and prefixed trace retained; missing route rejects, absent candidate skips grader/unavailable, malformed verdict error/3, negative verdict fails. |
| `advisory review inspects a blind change and cannot alter task grading`                   | Blind reviewer sees changed/untracked content and deterministic checks but no condition file; failed/malformed/thrown review cannot change task pass; dry not_run, inline fixture/invalid exclusion reject.                                      |
| `host failure retains completed trials and reports execution failure`                     | Second host rejection halts third admission, retains first/failed attempts and duration, exits 2/unassessed; private error body absent from evidence.                                                                                            |
| `engine refuses an equivalent live run before a second host starts`                       | Equivalent live run rejected before second host starts; original host completes successfully after release.                                                                                                                                      |
| `cancellation retains prior trial evidence and finalizes interruption`                    | SIGTERM during second trial retains first pass and cancelled attempt, exit 143/cancelled; interrupted owner and two completed-trial checkpoint entries.                                                                                          |
| `stores checkpoints apart from results and hides run state from shell checks`             | Separate active/checkpoint state references saved trial/run paths, no active directory under results; isolated shell cannot read private state and leaves it intact.                                                                             |
| `failed trial persistence retains its fixture and never returns success`                  | Blocked trial JSON persistence throws contextual failure, retains fixture and diagnostic active owner; never reports success.                                                                                                                    |
| `rejects fixture paths that could escape their workspace`                                 | Traversal fixture path never writes outside; invalid required ID and empty repository source refuse.                                                                                                                                             |
| `shell checks grade fixture effects and retain exit observations`                         | Shell grades created file with exact/positive/negative regex checks; check order preserved; observation retains exit 0, expected exit 0, SHA-256 and five raw stdout bytes.                                                                      |
| `shell failures and timeouts remain distinct from host completion`                        | Missing file or output mismatch yields completed/completed/failed/1; shell timeout completed/error/unassessed/3; absent isolation refuses.                                                                                                       |
| `engine retains a failed candidate workspace while preserving saved evidence`             | Failed candidate exits 2 and retains fixture/evidence plus workspace observation.                                                                                                                                                                |
| `engine retains the semantic workspace when grading fails`                                | Thrown semantic grader error exits 3 and preserves grader-created failure-details file.                                                                                                                                                          |
| `engine retains the candidate workspace when required grading evidence is unavailable`    | Missing required grading evidence exits 4, retains candidate fixture and run evidence.                                                                                                                                                           |
| `engine startup expires inactive failed workspaces after a day without deleting evidence` | Inactive failed workspace exists just before 24h and is removed just after; saved evidence bytes unchanged.                                                                                                                                      |
| `engine startup preserves an active workspace older than a day`                           | Peer startup after >24h preserves still-active workspace until its host completes.                                                                                                                                                               |
| `engine startup removes expired ownership records after a workspace was deleted manually` | Expired ownership record removed when its workspace was manually deleted.                                                                                                                                                                        |
| `engine startup preserves a workspace with unreadable ownership metadata`                 | Unreadable ownership metadata preserves failed workspace and evidence on later startup.                                                                                                                                                          |
| `engine startup preserves expired workspaces with unverifiable ownership`                 | Malformed/null/unknown-format/state/timestamp/owner/host, >4096-byte, insecure-mode, missing or symlink ownership preserves workspace/evidence and external metadata target.                                                                     |
| `engine startup cleanup tolerates concurrent evaluations expiring the same workspace`     | Ten concurrent-cleanup rounds safely expire same inactive workspace; four peer outcomes remain their genuine host failures (2).                                                                                                                  |
| `engine shell isolation hides a sibling created after sandbox launch`                     | Shell cannot read/write sibling created after sandbox launch or list ownership metadata, while own fixture access works.                                                                                                                         |
| `engine shell isolation hides project sources and explicitly protected peer fixtures`     | Shell cannot read project source or explicitly protected peer fixture; both expected refusal checks pass.                                                                                                                                        |

### [tests/extension-engine.test.ts](../../tests/extension-engine.test.ts)

| Exact source test title                                                            | Expected observable outcome                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension checks add to built-ins and retain negotiated provenance`               | Extension adds checks after built-in, retains declared evidence refs/metrics/source digest/protocol and active grader order.                                                                                    |
| `domain outcomes remain separate from the task verdict`                            | Failed domain outcome remains separate from passing task and matches result/evidence; invalid domain outcome yields grading error/unassessed.                                                                   |
| `explicit grader replacement removes only the selected built-in checks`            | Explicit replacement removes only selected built-in and binds provenance/identity; unknown replacement or no extension check rejects; replacing shell/semantic removes associated execution/route requirements. |
| `selected task policy may replace a failed check verdict and retains its decision` | Selected policy can pass failed check and retains policy/recommendation; absent recommendation error/3, unavailable evidence 4, host failure 2 cannot be overridden.                                            |
| `extension grading receives complete host observations`                            | Extension consumes complete host observation and refers to its ID in graded result.                                                                                                                             |
| `extension grading receives retained host artifacts`                               | Extension consumes retained host artifact and references its exact bytes/ID.                                                                                                                                    |
| `extension grading error cannot become a passing task`                             | Extension grading error gives completed/error/unassessed/3 with diagnostic while retaining prior passing built-in check.                                                                                        |
| `an omitted declared extension check leaves grading unavailable`                   | Omitted required declared extension check yields completed/unavailable/unassessed/4.                                                                                                                            |
| `unsupported instrumentation stops before host execution`                          | Unsupported instrumentation refuses before host called.                                                                                                                                                         |
| `negotiated instrumentation records host application and rejects condition drift`  | Negotiated enforced and passive-observational requests preserve application; passive execution-changing refuses; absent application/condition drift fails 2 with instrumentation.mismatch.                      |
| `prepared inline artifacts survive fixture cleanup with their digest`              | Prepared inline artifact remains readable after cleanup with original ID/bytes and SHA-256.                                                                                                                     |
| `negotiated fixture setup runs before artifacts and enters comparison identity`    | Negotiated setup runs before artifact mount; setup content present when host starts; setup/fixture digests and preparation refs retained.                                                                       |
| `fixture setup cannot redirect a preparation artifact outside the trial`           | Setup-created symlink refuses later artifact write; outside directory stays empty.                                                                                                                              |
| `fixture setup refuses an extension without its negotiated capability`             | Unnegotiated setup capability refuses before execution.                                                                                                                                                         |
| `prepared skill files stay outside Git status without hiding candidate edits`      | Prepared excluded skill files leave clean Git status; candidate README edit remains visible; gitExclude retained in artifact ref.                                                                               |
| `negotiated Codex marketplace reaches the host and binds fixture identity`         | Codex host receives marketplace root/name/plugins and four artifact paths; skill bytes mounted, redacted declaration and refs retained.                                                                         |
| `Codex marketplace requires negotiation and a valid artifact root`                 | Unnegotiated marketplace or invalid artifact root refuses before host.                                                                                                                                          |
| `negotiated Claude plugin directory reaches the host and binds fixture identity`   | Claude host receives plugin roots and selected artifact paths including both manifests/skill; bytes mounted and declaration/refs retained.                                                                      |
| `Claude plugin directory rejects unnegotiated or unsafe packages`                  | Claude package rejects unnegotiated/bad-root/missing-manifest/not-excluded scenarios before host.                                                                                                               |
| `explicit Codex invocation renders once and reaches the selected host`             | Packaged Codex invocation renders $probe:probe once and request declaration/identity retained; repeated/unnegotiated invocation refuses.                                                                        |
| `explicit repository invocation preserves scope and retained identity`             | Repository Codex invocation renders $probe and scope=repository with actual .agents mount, no marketplace; missing/repeated/not-excluded/unnegotiated/unsupported/conflicting declarations refuse.              |
| `explicit Codex invocation can occur in the continuation turn`                     | Codex packaged invocation may occur only in follow-up prompt while initial prompt unchanged; execution passes.                                                                                                  |
| `explicit Claude repository invocation renders a native project command`           | Claude repository invocation renders leading /probe with scope and .claude mount, no plugin-dir declaration; repeated/missing/not-excluded/nonleading/unnegotiated/unsupported/conflicting cases refuse.        |
| `explicit Claude invocation renders a packaged slash token`                        | Packaged Claude invocation renders /probe:probe and retained declaration; repetition/unnegotiated capability refuses.                                                                                           |
| `prepared executable artifact runs from the fixture and retains its mode`          | Prepared executable runs from fixture with ready output; executable=true and retained execute permission preserved (native execution guard on Windows).                                                         |
| `Git-excluded preparation artifacts require a Git fixture`                         | Git-excluded artifact on inline fixture refuses.                                                                                                                                                                |
| `declared source artifacts are retained and mounted with verified bytes`           | Declared mapped source artifact mounts and retains verified original bytes.                                                                                                                                     |
| `a wrong preparation digest fails before host execution`                           | Wrong declared artifact digest rejects before host call.                                                                                                                                                        |
| `a changed retained artifact cannot support a successful result`                   | Candidate-time tampering of retained prepared artifact makes run reject rather than succeeding.                                                                                                                 |

### [tests/preparation.test.ts](../../tests/preparation.test.ts)

| Exact source test title                                              | Expected observable outcome                                                                                                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preparation validates bytes, digest, and portable path containment` | Valid bytes/flags accepted; traversal, exact/ancestor collision, noncanonical base64, unsupported sourceRef, wrong hash, nonboolean flags and excluded path control characters reject. |
| `source references resolve only from the declared case source map`   | Mapped file bytes and executable/gitExclude flags resolve only from declared root/ref; missing map/root/ref, outside/symlink escape, bad flag or digest rejects.                       |
| `preparation artifacts cannot follow fixture symlinks`               | Fixture symlink parents and existing dangling symlink target reject; legitimate new nested target allowed; outside directory untouched.                                                |

### [tests/cli-concurrency.test.ts](../../tests/cli-concurrency.test.ts)

| Exact source test title                                                            | Expected observable outcome                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI bounds parallel trials and retains ordered isolated evidence`                 | jobs=2 bounds five trials to peak 2 with five isolated original fixtures; result/evidence/checkpoint sorted 1..5, trial files equal returned trial, successful workspaces removed. |
| `CLI parallel cancellation drains active trials and stops queued trials`           | SIGINT with two active/six requested drains exactly two, admits no queued trial; both cancelled retained, exit 130, interrupted owner, retained fixtures.                          |
| `CLI parallel persistence failure retains a completed peer before finalizing`      | Artifact persistence failure exits 70, admits only active pair, retains completed peer/one checkpoint and failed fixture, cleans successful peer, diagnostic owner.                |
| `CLI defaults to three trial jobs and serial limits change configuration identity` | Default four-trial run peaks at 3; jobs=1 peaks at 1; redacted settings and identity differ.                                                                                       |
| `CLI refuses invalid job limits before creating run storage`                       | Empty/zero/negative/fractional/NaN/Infinity/unsafe jobs fail 64/not_run naming jobs, create neither results nor state.                                                             |
| `CLI retains interruption before admitting its first trial`                        | SIGINT/SIGTERM before first admission retains cancelled/unassessed empty run and interrupted checkpoint, no candidate call, exact 130/143.                                         |
| `CLI sandbox denies read and write access to later admitted peer fixtures`         | macOS sandbox prevents already-running shell from reading/writing later-admitted fixture; own file writable, peer remains original, all three trials finish.                       |
| `CLI closes queued admission when grading fails before advisory retention`         | Required semantic failure closes queue before held advisory completes; only two start, exit 3/error, both active trials and completed advisory results retained.                   |
| `CLI execution failure stops queued trials and retains an active peer`             | First executionFailed stops queued work, active peer completes; exit 2, two saved trials match returned results, owner complete with both entries.                                 |

### [tests/main-sync-cli.test.ts](../../tests/main-sync-cli.test.ts)

| Exact source test title                                                     | Expected observable outcome                                                                                                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public CLI selects the native Codex execution timeout`                     | Codex app-server with 1200000ms completes/pass; 1ms times out as execution failed/2/unassessed with partial native-goal time-bound evidence.             |
| `public CLI refuses invalid native Codex timeout %s before a run`           | Empty/zero/negative/fractional/NaN/Infinity/>1800000/unsafe timeout fails 64/not_run/null evidence/empty cases with invalid Codex host configuration.    |
| `public CLI accepts the default and maximum Codex timeout for %s`           | Both exec/app-server accept default and exact 1800000ms maximum in dry mode, exit 0/not_run.                                                             |
| `public CLI records goal absence at the actual user feedback boundary`      | At actual follow-up boundary absent native goal retained as observed=false/status=null; final native goal can later complete with two client turns.      |
| `public CLI retains failed app-server evidence without passing the task`    | Fatal app-server turn error yields 2/failed/unassessed and partial native-goal failure plus unauthorized error fact.                                     |
| `public CLI observes Codex native continuation without sending extra turns` | Native autonomous completion observed with one client turn and native-2 final turn; app-server configuration retained, private goal objective omitted.   |
| `public CLI retains Claude native goal facts without the objective`         | Claude native goal observation binds session/status and objective character count, never objective text.                                                 |
| `public CLI grades a saved artifact independently of the final response`    | Separate response and saved-document semantic sources yield response pass but artifact fail/exit1; observation records concrete notes/final-123.md path. |

### [tests/main-sync-repair-cli.test.ts](../../tests/main-sync-repair-cli.test.ts)

| Exact source test title                                                 | Expected observable outcome                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `public CLI rejects saved document aliases into Git metadata`           | Saved-document symlink alias into .git yields grading error even if injected grader would pass.                     |
| `public CLI observes native goal readback without update notifications` | Native goal readback without notification records active goal at continuation boundary and omits private objective. |
