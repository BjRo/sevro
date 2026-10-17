# Rust port: delivery and tooling parity

This specification records the delivery, consumer installation, documentation,
guide-evaluation, property, and quality-gate behavior that the Rust port must
preserve. It is derived from the existing tests and executable verifiers named
below. Reading a test establishes its intended assertion; it does not establish
that the test has passed against Rust.

The migration must deliver the installed `sevro` workflows as well as the runner.
Passing a Rust unit suite alone cannot establish consumer or native-host parity.
The [public contracts](../contracts.md), [contribution rules](../../CONTRIBUTING.md),
[documentation contract](../documentation-quality.md), and
[release contract](../releases.md) remain applicable.

## Implementation boundary

The existing Bun tests are a behavior oracle during migration. Preserve and run
them while their TypeScript implementation remains in the tree. Preserve the
explicit source inventory, strict typing, lint, generated-schema freshness, and
both independent 95% statement and branch gates for that implementation. A Rust
slice must gain durable tests at its public seam before replacing behavior.

Rust coverage must use compiler instrumentation through `cargo-llvm-cov` and
LLVM's profiles and reports. Do not recreate the TypeScript AST instrumenter,
JavaScript process hooks, or static branch-projector in Rust. Cargo compilation,
formatting, lint, tests, and compiler coverage replace language-specific tooling;
the observable completeness and evidence requirements below survive that change.
Record the pinned compiler/tool versions and compiler-defined coverage units.
LLVM regions or lines must not be labelled as Istanbul statements, and a passing
line metric must not substitute for independent branch validation. Any explicit
mapping of the quality contract to compiler-native units belongs in the Rust
quality contract and must retain the 95% bar for its independently named metrics.

Keep the TypeScript quality tools while they still govern retained TypeScript
sources, tests, examples, or adapters. Their eventual removal requires an
explicit replacement for every applicable assertion below. The npm consumer
contract, public JSON schemas, TypeScript adapter/extension compatibility,
recipes, and guide harness are user-visible compatibility requirements, not
permission to discard those consumers when the runner becomes Rust. Packaging
may carry a native executable, but must preserve the package identity, installed
command, assets, provenance, and tested workflows. The existing direct source
entrypoints in verifiers must be deliberately updated to exercise the packaged
Rust command when that packaging changes.

## Acceptance environments and execution gates

The [current workflow](../../.github/workflows/verify.yml) runs hosted acceptance
on `ubuntu-24.04` x64. macOS arm64 is the documented local native-isolation
environment; the current workflow does not contain a macOS hosted job. Preserve
both supported platform paths and obtain candidate-specific evidence for each.
Windows remains unverified; a filename branch for `sevro.cmd` is not Windows
acceptance evidence.

| Environment           | Required prerequisites and behavior                                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared baseline       | Bun 1.3.13, Node 24.13.0, npm, Git, and `rg`; locked dependencies; native tests use pinned Codex 0.160.1 and Claude Code 2.1.284. Retain required runtimes for existing adapters and examples during migration. Add pinned Rust/compiler-coverage tools for Rust gates. |
| macOS arm64           | Actual `sandbox-exec` isolation and supported Keychain/Apple-discovery paths; `/usr/bin/cc` from Command Line Tools for synthetic libc fixtures. The installed-package synthetic Claude isolation check runs on macOS.                                                  |
| Ubuntu 24.04 x64      | Actual `bubblewrap`, `socat`, and `rg`, configured by [setup-ci-linux.sh](../../scripts/setup-ci-linux.sh), with non-root isolation acceptance. Apple-only modules are outside this platform's executable coverage scope, while shared code remains measured.           |
| Documentation recipes | Python 3, UV, mise, and an installed `node@24.13.0` in mise. Hosted docs currently pins UV 0.11.21 and mise 2026.3.13. A missing prerequisite produces its setup instruction and fails; it does not skip the recipe.                                                    |

The current complete command is `bun run check:typescript`. After frozen
installation, `--fast` runs only static checks; `--phase static|docs|tests|package`
selects one canonical phase. Each phase checks the source inventory and reports
elapsed time even on failure. The complete command installs frozen dependencies
and runs all four phases. The Rust replacement must retain the same breadth:

| Phase     | Required evidence                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static`  | Source accounting, schema freshness, docs, formatting, lint, and type/compiler checks.                                                                                                                                |
| `docs`    | Every guide case's dry preparation, exact tutorial commands, and recipe verification. The current complete gate dry-prepares every guide case through Codex; focused tests additionally prove Claude dry preparation. |
| `tests`   | Real filesystem/process/protocol integration tests, integrity controls, and independent coverage thresholds over the complete applicable production inventory.                                                        |
| `package` | A real installed candidate, isolated from source Git metadata, exercising CLI workflows, grading, prompt-only execution, provenance, and reporting.                                                                   |

For implementation PRs, required GitHub CI checks must pass for the exact
published commit. Local fast checks, selected tests, a previous green SHA, and
pending jobs are insufficient. Keep failed-job evidence, repair failures, and
push non-force updates to the same draft PR. The current stable status is
`TypeScript quality`; changing job names also requires updating the release
evidence selector. Superseded runs on one PR are cancelled, independent test
shards do not cancel siblings on failure, and missing/cancelled/skipped/failed
required jobs cannot yield aggregate success.

## Coverage and gate regression inventory

These tests describe the TypeScript implementation of the gate. Their
language-specific mechanisms remain until retired deliberately; their integrity
properties must also constrain the compiler-based Rust gate.

### Public quality gate

Source: [tests/typescript-quality.test.ts](../../tests/typescript-quality.test.ts).
The exact test titles and parameter sets are:

| Test                                                                                            | Required observation                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release CI evidence controls require complete fresh phases and test shards`                    | The Python release-evidence regression suite exits zero and reports `OK`.                                                                                                                                                                                   |
| `the public TypeScript gate refuses invalid phase selection %j`                                 | Missing phase, `unknown`, and `static extra` exit 1, explain `--phase static\|docs\|tests\|package`, and do not begin a phase.                                                                                                                              |
| `direct public coverage refuses %s`                                                             | Unregistered authored CJS/TS, missing inventoried source, overlapping source dispositions, and authored CJS misclassified as generated fail before coverage with the matching inventory diagnostic.                                                         |
| `the public TypeScript gate covers host-reachable production and excludes generated validators` | Scope-probe baseline and merged files equal the declared host-reachable inventory; excluded and generated files are absent. Generated CJS still validates normally, and its copied bytes remain unchanged. The recorded run scope matches the actual scope. |
| `platform coverage retains reachable outcomes and refuses an executed exclusion`                | Only platform-impossible branch outcomes are removed, with exact count changes; a nonzero excluded counter fails with `Platform-unreachable branch was executed`. Rust uses compiler platform configuration instead of reproducing this AST analysis.       |
| `the public TypeScript gate copies exact candidate inputs and deletions with independent Git`   | The snapshot probe preserves the actual candidate, including deletions, and independent Git metadata.                                                                                                                                                       |
| `the public TypeScript gate rejects missed branches independently`                              | A five-of-five statement sample with one missing branch exits 1 with `Below 95%: branches`; statement coverage does not mask branch failure.                                                                                                                |
| `the public TypeScript gate refuses unregistered source file %s`                                | Each of `stray.ts`, `stray.tsx`, `stray.mts`, and `stray.cts` is refused by the inventory command.                                                                                                                                                          |
| `the public TypeScript gate refuses absent process reports`                                     | The missing-report probe exits 1 with `Missing coverage reports`.                                                                                                                                                                                           |
| `the public TypeScript gate validates process completion and report integrity`                  | Zero-count unimported production stays counted; missing children, missing branch data, stale/incompatible reports, ordinary checkpoints, and unowned force-kills are refused. Explicitly owned force-kill checkpoints are conservative.                     |
| `the public TypeScript gate preserves original TypeScript counter and stack locations`          | Source-map probe points to original source line 6. Rust compiler reports must likewise refer to authored source locations.                                                                                                                                  |
| `the public TypeScript gate audits all stored reports before choosing completion`               | Unregistered completion, stale discarded checkpoint, misnamed completion, and unexpected report files are refused; selecting completion preserves exact counters.                                                                                           |

The current inventory dispositions are production, generated, declarations,
tooling, tests, and examples. All are checked for their declared purpose. Only
the five exact generated AJV validators are excluded as generated code; that
exception cannot hide authored code. Test/fixture/tooling/example sources do not
enter the runner-production coverage denominator. The complete applicable
production inventory includes unimported files at zero, and platform-specific
exclusions are explicit and measured on the opposite supported platform.

Preserve candidate identity, run identity, source layout, nonnegative integer
counters, process completion, and report-source validation before merging.
Record missing or force-killed process evidence honestly: no fabricated tail
counters and no inferred success. A lost force-kill tail may conservatively
lower coverage. Preserve the actual cancellation/SIGKILL behavior tests when
changing measurement. Under LLVM, use the compiler's collection facilities and
explicit process evidence rather than adding a second source instrumenter.

Current reports under `.quality/coverage` retain source snapshot, baseline,
ledger, test log, merged/raw counters, scope, exact enforcement counts, LCOV, and
HTML. Diagnostic selected-test reports use `.quality/coverage-targeted` and still
enforce the full denominator. The Rust report set must identify equivalent
source, raw profile, test, scope, and threshold evidence, keeping diagnostic
measurements distinct from full acceptance. See the
[coverage tooling inventory](../../scripts/coverage/README.md) for the current
preparation, capture, report, platform, probe, and shard modules.

### Sharded execution

Source: [tests/coverage-shards.test.ts](../../tests/coverage-shards.test.ts), with
[the subprocess fixture](../../tests/fixtures/coverage-shards.ts).

| Exact test title                                                                             | Required observation                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `four coverage shards jointly satisfy branches that each partial run misses`                 | Merge raw contributions before applying thresholds once; a partial shard may miss a branch that the complete suite covers.                                    |
| `coverage aggregation refuses a shard with different %s`                                     | Refuse mismatched `candidate`, `batch`, `platform`, `arch`, `bun`, or `layout`. A Rust manifest must bind the equivalent compiler/toolchain and build layout. |
| `coverage aggregation refuses missing and duplicate shards`                                  | Require every expected shard exactly once.                                                                                                                    |
| `failed-job reruns can reuse passing shards from the same workflow run`                      | Different attempts within the same batch can merge; another workflow run cannot supply missing evidence.                                                      |
| `coverage aggregation refuses reused run identities and changed file assignments`            | Require unique run IDs and the exact assigned test files.                                                                                                     |
| `coverage aggregation preserves the whole inventory and rejects incomplete counters`         | Refuse missing production files and incomplete branch counters.                                                                                               |
| `coverage aggregation includes unimported zero-count files in the final denominator`         | Keep never-executed production in the merged denominator so it can fail 95%.                                                                                  |
| `coverage normalization combines different snapshot paths without changing layout`           | Normalize snapshot roots without changing source/counter layout; refuse paths escaping the source snapshot.                                                   |
| `the shard plan executes every discovered test file exactly once and separates guide groups` | Four deterministic shards cover the complete discovered test inventory exactly once, one guide group per shard, independently of discovery order.             |
| `shard selection refuses invalid index %s`                                                   | Refuse `0/4`, `5/4`, `1/3`, `1/4extra`, and absent selection.                                                                                                 |
| `public shard commands merge real subprocess counters and enforce coverage once`             | Real subprocess partial runs include a 50% branch result; combined four-shard output reports 100% statements and branches.                                    |

Four shards and Bun-specific index syntax describe the current harness; Rust
may use Cargo's test execution and a deliberately documented scheduling scheme.
Every retained test must still execute exactly once in an acceptance run, and
coverage aggregation must reject partial or mismatched evidence. Keep shard
process identities separate even when operating-system PIDs repeat across
runners. Retain each producing attempt and replace only its own artifact on a
failed-job rerun.

## Cross-language properties

Source: [tests/typescript-properties.test.ts](../../tests/typescript-properties.test.ts).
These are product properties despite the filename. Existing generated cases use
fast-check seed `20261007`, 200 runs, and `endOnFailure: true`; preserve failing
seeds/replay paths and durable regression inputs when translating to Rust.

| Exact test title                                                                                                          | Required observation                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolved minimal repository fixtures preserve the source reference without inventing overlays or tools`                  | A minimal repository fixture resolves to exactly `sourceRef`, round-trips through preparation, and leaves negotiated data unchanged.                                                                                                                                                                                 |
| `resolved repository fixtures preserve optional overlay, staging, and tool declarations without mutating negotiated data` | Preserve optional files, staged paths, commit-files intent, hooks, and fixture binaries. Resolution removes only the repository `kind`, retains declared data, round-trips, and does not mutate input.                                                                                                               |
| `resolved inline and generated fixtures retain their declared bytes and history`                                          | Inline resolution retains file bytes; generated resolution retains commits, worktree files, staged state, and history, without input mutation.                                                                                                                                                                       |
| `canonical JSON round trips and hashes remain stable across key order`                                                    | Reordering object keys preserves canonical serialization and hash; canonical JSON parses to normalized JSON and is idempotent. Include the source property's arbitrary string keys and nested JSON values.                                                                                                           |
| `Codex JSONL preserves Unicode messages and exact cumulative token counts`                                                | Preserve nonempty thread IDs, arbitrary messages, and nonnegative cumulative token counts through the JavaScript safe-integer range, including blank surrounding lines. A nonzero process exit prevents completeness.                                                                                                |
| `CLI schemas preserve unassessed outcomes across serialization and reject lost required state`                            | Preserve all execution states (`completed`, `failed`, `cancelled`, `not_run`) and grading states (`completed`, `error`, `unavailable`, `not_requested`) with `not_assessed`; reject removal of each required root member: `format`, `runId`, `execution`, `grading`, `task`, `exitCode`, `evidencePath`, or `cases`. |

## Installed-package behavior

Primary executable oracle:
[scripts/verify-package-install.ts](../../scripts/verify-package-install.ts),
invoked by `scoped package installation retains the sevro command and release
provenance` in [tests/release.test.ts](../../tests/release.test.ts).

1. Without `--tarball`, pack the candidate using `npm pack --ignore-scripts`.
   With it, require an existing absolute file, install that exact artifact, and
   do not repack or alter it. Check source release documentation before packing
   or installation, then check the installed artifact's documentation too.
2. Install into a fresh consumer. The package is `@bjoernrochel/sevro`, its
   version equals source metadata, and `node_modules/.bin/sevro` exists.
   Installed contents omit `.git` and `tests`, retain public run-evidence/report
   schemas, and include basic graded and prompt-only examples. Cleanup always
   removes temporary consumers and result directories.
3. Run the installed command with the packaged basic host adapter. A graded
   one-trial case yields exit 0, completed execution/grading, and `passed`.
   Its retained runner provenance is `source: package`, the scoped package
   name and actual version, and a 64-hex build digest. Evaluation identity uses
   the same runner digest and a valid 64-hex project digest without source Git.
4. A prompt-only case yields exit 0, completed execution, `not_requested`
   grading, and `not_assessed` in both CLI result and retained evidence. It has
   one trial and zero checks; successful execution cannot invent task success.
5. On macOS, the installed synthetic Claude route receives its isolated private
   credentials, sees the declared curated UV cache, cannot inherit
   `DARROW_CACHE_DIR`, and can write inside its isolated home. Native and shell
   checks pass with required tool-call/native-control evidence; retained route
   is `sevro.host.claude` with the requested synthetic model and package version.
6. Reporting the saved graded and prompt-only results yields
   `sevro.report.v1`, one passed and one not-assessed row, a measured duration
   for the executed candidate, and unknown (`null`) cost rather than invented
   cost.

[scripts/documentation-workflow.ts](../../scripts/documentation-workflow.ts)
adds installed CLI acceptance: `demo --json`; `init` of `response` and `coding`;
each template's pass, fail, and dry runs from `run.json`; and `report --latest`.
Pass/fail exits and verdicts are 0/passed and 1/failed; dry is 0/not_assessed,
has null candidate duration, and becomes the latest report. Retained run evidence
equals the emitted CLI result. The `repository-skill` template dry-prepares with
synthetic auth, returns `not_run`/`not_assessed`, and retains the
`template.startup-skill` artifact. These checks do not execute an authenticated
model.

## Release artifact and documentation parity

Source: [tests/release.test.ts](../../tests/release.test.ts), backed by
[prepare-release.ts](../../scripts/prepare-release.ts) and
[release-documentation.ts](../../scripts/release-documentation.ts).

| Exact test title                                                                      | Required observation                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `release CI requires complete fresh quality evidence`                                 | The release-evidence regression suite succeeds.                                                                                                                                                                                                                                                                                                        |
| `scoped package installation retains the sevro command and release provenance`        | The full installed-package oracle above succeeds.                                                                                                                                                                                                                                                                                                      |
| `release preparation refuses stale documentation before creating an artifact`         | Exit 1, name `bun run docs:sync`, leave documentation untouched, and create no output directory.                                                                                                                                                                                                                                                       |
| `release preparation retains a real tarball, identity, inventory, and checksums (%s)` | Both `next` and `latest` produce `sevro.release.v1`, matching package/version/tag, actual tarball SHA-256 and npm SHA-512 integrity, Node/npm runtime versions, `release.json`, and exact `SHA256SUMS`. Include LICENSE, exclude private tests, execute no lifecycle hook, and need no `.git`. Repeating the same output fails without changing bytes. |
| `release preparation refuses invalid %s configuration before producing artifacts`     | Reject development versions, mismatched release tags, unlicensed metadata, unsupported distribution tags, wrong repository, and relative output directories; emit no successful result and leave no output.                                                                                                                                            |
| `release preparation refuses missing runtime assets without leaving a candidate`      | A missing public report schema fails and leaves no candidate.                                                                                                                                                                                                                                                                                          |
| `release preparation refuses unexpected root files despite a permitted prefix`        | `LICENSE.extra` is outside the exact package contract despite sharing an allowed prefix.                                                                                                                                                                                                                                                               |
| `the package installation gate rejects a different candidate version`                 | A supplied tarball whose version differs from source fails with the identity diagnostic and retains its original bytes.                                                                                                                                                                                                                                |

The fixture's synthetic MIT license is test data, not a licensing decision.
Preserve the actual owner-selected package license and authoritative LICENSE
bytes. Publication, registry promotion, Git tags, and changing licensing remain
separate maintainer actions; the Rust-port PR does not authorize them.

Source: [tests/release-docs.test.ts](../../tests/release-docs.test.ts), backed by
[sync-release-docs.ts](../../scripts/sync-release-docs.ts).

| Exact test title                                                      | Required observation                                                                                                                                                                     |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check:docs refuses stale current release without mutation`           | Diagnose stale release text and fail without rewriting it.                                                                                                                               |
| `docs:sync installs rc.4 and preserves surrounding historical bytes`  | Rewrite only the marked Current release section to the manifest's exact installation command; preserve before/after bytes and make `check:docs` pass. The named version is fixture data. |
| `release commands refuse %s section without writing`                  | Both sync and check reject missing, duplicate, or reversed section markers without mutation.                                                                                             |
| `release commands refuse invalid manifest version %j without writing` | Reject `1.2`, `01.2.3`, `1.2.3-rc.01`, a newline command-injection value, empty string, and `../release`; preserve documentation bytes.                                                  |
| `docs:sync supports stable versions and repeats without byte changes` | Stable semver produces the exact scoped install command and synchronization is byte-idempotent.                                                                                          |
| `package validation refuses stale documentation`                      | Stale source docs fail package validation without mutation.                                                                                                                              |
| `package validation checks the supplied artifact's current release`   | Fixing source docs cannot excuse stale docs inside an earlier tarball; reject that exact artifact and preserve its bytes.                                                                |

Release-only CI continues to reuse successful source evidence from a matching
ancestor on main, with only the explicitly allowed release metadata changes.
It runs static metadata checks and records the original source SHA/run URL; it
does not rerun full acceptance or report reused measurements as new coverage.
Implementation changes, including this port, require fresh full acceptance.

The full evidence-selector regression inventory in
[.github/scripts/test-release-ci.py](../../.github/scripts/test-release-ci.py)
is: `test_accepts_complete_parallel_gate`,
`test_accepts_complete_sharded_gate`,
`test_sharded_gate_requires_all_four_shards`,
`test_sharded_gate_refuses_failed_skipped_cancelled_and_duplicate_shards`,
`test_sharded_gate_requires_successful_shard_steps_and_aggregate_marker`,
`test_requires_every_phase`, `test_refuses_unsuccessful_jobs_and_steps`,
`test_requires_the_phase_step`, `test_refuses_ambiguous_phase_jobs`,
`test_accepts_historical_full_gate`,
`test_historical_gate_cannot_excuse_incomplete_parallel_evidence`,
`test_refuses_unsuccessful_or_ambiguous_historical_gate`,
`test_reused_release_status_is_not_fresh_test_evidence`, and
`test_refuses_missing_evidence`. Keep these fail-closed rules when adding Rust
job names and gate steps to the selector.

## Documentation and executable examples

Source: [tests/documentation.test.ts](../../tests/documentation.test.ts).

| Exact test title                                                                                     | Required observation                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Markdown parser ignores code links and applies duplicate GitHub heading anchors`                    | Ignore Markdown-looking links inside fenced code, discover actual links, suffix duplicate headings (`results-1`), and retain explicit HTML IDs.                                                                                                                           |
| `Markdown and HTML images need alternatives and fenced commands need languages`                      | Reject empty alternatives on both image forms and unlabelled command fences, while recording image destinations.                                                                                                                                                          |
| `Declarative guide answer rules reject generic reassurance`                                          | Generic reassurance fails the explicit, missing-evidence, and unauthorized-effect cases' built-in output checks.                                                                                                                                                          |
| `native source inspection distinguishes documentation from skill mount paths`                        | Successful native content reading yields the repository-relative documentation source, demonstrated by `README.md`. The guide contract separately distinguishes documentation reads from selection observations.                                                          |
| `the native hook warning is not an effect while commands, errors and unknown actions remain guarded` | The specific hook-trust diagnostic is exempt; a failed mutating command, unknown action, and unknown native error still count as attempted effects.                                                                                                                       |
| `Read-only command classification ignores words in grep patterns and rejects execution`              | Permit bounded content reads and literal search patterns, including shell-wrapped `rg`; reject execution, network calls, tracker/Git mutation, output redirects, command substitution, executable preprocessors, unrestricted globs, and mutating/executing sed programs. |
| `Lexical signals cannot validate contradictory benchmark claims`                                     | Mentioning expected words cannot pass contradictory explicit/stale answers; an answer alone proves no source inspection.                                                                                                                                                  |
| `mentioning or listing a source is not content inspection`                                           | Echo/printf, `rg --files`, count-only rg/grep, `ls`, and Claude Grep files-with-matches output establish no inspected contents.                                                                                                                                           |
| `Guide dry validation selects a case without invoking %s`                                            | Both Codex and Claude dry runs accept unusable binary paths, retain `not_run`/`not_assessed`, and return a run evidence path.                                                                                                                                             |

The broader local docs checker preserves local destinations and anchors, asset
references, accessible alternatives, language-tagged fences, exact guide
mirrors, guide inventory source/static destinations, and complete case coverage.
It excludes inactive fixture snapshots and runs without network. External links
remain a separate check with two retries for transient failures and referring
page/URL diagnostics. A successful link does not establish a claim's truth.
Relevant tooling is [check-docs.ts](../../scripts/check-docs.ts),
[documentation-markdown.ts](../../scripts/documentation-markdown.ts),
[documentation-links.ts](../../scripts/documentation-links.ts), and
[documentation-inventory.ts](../../scripts/documentation-inventory.ts).

[verify-doc-examples.ts](../../scripts/verify-doc-examples.ts) reads the exact
marked `sh` blocks in `docs/getting-started.md`. Its
[package helper](../../scripts/documentation-example-packages.ts) runs them in
separate fresh candidate-consumer, published-consumer, and contributor
directories. Candidate installation checks exact LICENSE and CONTRIBUTING
bytes; both consumers check package-license metadata and nonempty LICENSE.
The contributor checkout has independent Git metadata, current candidate
inputs, and frozen dependency installation. Preserve separate candidate and
published outcomes; published-version success is not candidate acceptance.

The [result helper](../../scripts/documentation-example-results.ts) requires
each marked shell block, validates CLI/run evidence schemas, and executes both
graded and prompt-only modes. Graded results are completed/completed/passed;
prompt-only results are completed/not_requested/not_assessed. Both exit zero,
retain exactly one trial, and keep matching evidence inside the intended
`sevro-results` directory. Execution errors retain diagnostic context and the
CLI result. Temporary directories are always cleaned.

[documentation-recipes.ts](../../scripts/documentation-recipes.ts) copies the
candidate's packaged recipes into a separate consumer project and runs the exact
marked commands from `docs/recipes.md`:

- `coding-change`, `host-tools`, `node`, `python-uv`, `mise`, `semantic`, and
  `lifecycle` each execute deterministic pass and fail controls, then dry-prepare
  both Codex and Claude routes.
- `repository-skill` and `plugins` dry-prepare both native routes with positive
  and `--fail` inputs; `goals` dry-prepares both hosts.
- Pass requires exit/result 0, completed execution/grading, and passed verdict.
  Fail requires exit/result 1, completed execution/grading, and failed verdict.
  Dry requires exit/result 0, not_run/not_requested/not_assessed.
- Every recipe retains schema-valid evidence beneath `.sevro-recipes`, matches
  the CLI verdict, has one trial, and verifies prepared artifact bytes against
  their recorded SHA-256 hashes.

These recipe checks do not claim authenticated model, goal, or plugin-hook
execution. `SEVRO_RECIPE_CLI` currently points to installed `src/cli.ts`; its
migration must select the installed Rust entrypoint while preserving the
existing declared examples and host/extension interoperability.

## Guide-evaluation parity

The [guide contract](repository-guide.md) and
[guide evaluation contract](../guide-evaluation.md) remain in force. Canonical
and Claude guide mounts stay byte-identical and repository-only. The evaluator
uses Sevro's standard CLI, fixture isolation, host continuation, invocation
receipts, cancellation, retention, and cleanup; it must not become a separate
runner. Cases and evaluator code remain withheld from participant workspaces.

The four entry files are
[codex-positive.test.ts](../../tests/guide/codex-positive.test.ts),
[codex-negative.test.ts](../../tests/guide/codex-negative.test.ts),
[claude-positive.test.ts](../../tests/guide/claude-positive.test.ts), and
[claude-negative.test.ts](../../tests/guide/claude-negative.test.ts). They register
the shared cases in
[tests/fixtures/guide-evaluation.ts](../../tests/fixtures/guide-evaluation.ts)
using the synthetic [guide host](../../tests/fixtures/guide-host.ts).

For each host, `Sevro executes and grades guide case $host/$id` covers all 11
IDs: `orientation`, `explicit`, `unrelated`, `missing`, `conflict`, `stale`,
`follow-up`, `unauthorized`, `extension-architecture`, `contribution`, and
`licensing`. Each accepted case yields exit 0, completed execution/grading,
passed verdict, all checks passed, and retained `sevro.trial-evidence.v1` with
artifact references.

For each host, `Sevro refuses $host/$scenario guide evidence` covers every row
below. Every row exits nonzero and retains `sevro.run-evidence.v1`.

| Case         | Scenario             | Required verdict |
| ------------ | -------------------- | ---------------- |
| unrelated    | effects              | failed           |
| unrelated    | changed              | failed           |
| unrelated    | missing-events       | not_assessed     |
| unrelated    | partial              | not_assessed     |
| explicit     | missing-receipt      | not_assessed     |
| explicit     | wrong-receipt        | failed           |
| follow-up    | stale-follow-up      | failed           |
| follow-up    | missing-follow-up    | not_assessed     |
| unrelated    | failed               | not_assessed     |
| orientation  | changed-mount        | failed           |
| unrelated    | extra-directory      | failed           |
| orientation  | missing-selection    | not_assessed     |
| orientation  | partial-selection    | not_assessed     |
| follow-up    | missing-continuation | not_assessed     |
| explicit     | bad-answer           | failed           |
| stale        | bad-answer           | failed           |
| missing      | bad-answer           | failed           |
| unauthorized | bad-answer           | failed           |

Codex-positive adds `Sevro guide grading accepts read-only searches with literal
path globs` (the `unrelated`/`glob-read` scenario passes) and `Guide results use
Sevro built-in answer and fixture graders` (passed `sevro.regex` and
`sevro.shell` checks, plus exactly `sevro.guide.selection`,
`sevro.guide.no-effects`, and `sevro.guide.inspected-citation` extension checks).

[tests/guide-host-receipts.test.ts](../../tests/guide-host-receipts.test.ts)
contains `Sevro requires hook evidence even when the event transcript contains
a full skill body: $emitHooks`. With complete hooks, the synthetic Codex route
passes and records `sevro.host.skill-activations` from `sevro.host.codex`, method
`tool_result_body_match`, completeness `complete`, and observed skill `probe`.
Without hooks, the same full-body transcript yields partial activation evidence,
no observed skills, and cannot pass. A failed missing-skill read or a skill-file
listing does not create activation. The test requires an available native
Codex executable and supported isolation; an early return due to unavailable
prerequisites is not evidence that the Rust native path works.

Preserve the distinct evidence roles: answers use built-in regex checks,
workspace integrity uses shell checks, inspected citations require actual
content reads, explicit invocation requires complete dispatch receipts, and
automatic selection requires complete host skill-activation observations.
Codex's passive tool-result hooks and Claude's successful native Skill calls
remain the respective selection sources. Missing events, partial turns,
missing receipts, and absent fresh follow-up reads cannot become a pass.
Synthetic and dry runs are deterministic acceptance evidence for their tested
boundaries; they do not establish live model behavior.
