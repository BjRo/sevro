# TypeScript quality

`bun run check:typescript` is the local and CI acceptance command. It performs a
frozen dependency installation, checks the complete source inventory, verifies
generated schemas, formatting, type-aware lint and typing, exercises coverage
integrity controls, runs the deterministic Bun suite in an isolated instrumented
copy, enforces statements and branches independently, and validates installation
of the published package. Runtime dependencies and public evaluation semantics
remain part of the existing package-install contract.

Use `bun run check:typescript --fast` before committing. It checks inventory,
schemas, formatting, lint and types without the full integration suite, coverage
or package installation. Install dependencies with `bun install --frozen-lockfile`
first. Quality dependencies are development dependencies pinned in `bun.lock`.

## Source dispositions

[`typescript-sources.json`](../typescript-sources.json) explicitly lists every
TypeScript and JavaScript source. The guard refuses new, missing or duplicated
files and declarations outside the configured TypeScript project. Changing a
source disposition requires review; adding a glob is not a substitute for the
inventory. Unsupported executable production extensions cannot be assigned to
the production inventory: the current instrumenter supports authored `.ts` and
the four exact generated `.cjs` files. New `.tsx`, `.mts`, `.cts` or JavaScript
production requires an explicit instrumentation and quality-policy change first.

| Inventory      | Lint and typing                                                                                      | Test and coverage disposition                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production`   | Type-aware strict lint and strict compiler                                                           | All executable `src` statements and branch outcomes, including unimported files                                                                                                                      |
| `generated`    | CommonJS syntax parsing, exact `schemas:check` freshness, and checked `.d.cts` boundary declarations | Real Bun schema tests and the complete production coverage denominator                                                                                                                               |
| `declarations` | Type-aware lint and compiler                                                                         | Declaration-only files have no executable counters                                                                                                                                                   |
| `tooling`      | Same type-aware lint and strict compiler; `.mjs`/`.cjs` use `checkJs` and explicit JSDoc contracts   | Durable public gate probes, schema freshness, release and installed-package tests; outside the runner-production denominator                                                                         |
| `tests`        | Same type-aware lint and strict compiler, including fixtures                                         | Real Bun filesystem/process/protocol tests; outside the production denominator                                                                                                                       |
| `examples`     | Same type-aware lint and strict compiler                                                             | Packaged demonstration host adapters are synthetic consumer fixtures, exercised by installed-package validation; they implement no runner behavior and are outside the runner-production denominator |
| `historical`   | Byte-preserved prototype evidence, separately inventoried                                            | Archived discovery harness and observations, not active quality tooling or runner code                                                                                                               |

Generated AJV CommonJS is deliberately not rewritten to conform to authored-code
rules. Applying ESLint's recommended JavaScript rules to the four exact generated
files found 879 redeclarations, 281 useless assignments, 182 unused variables and
108 unreachable-code findings. Those are generator emissions. Their syntax,
generation freshness, typed public boundaries, runtime behavior and full coverage
remain checked. This disposition does not apply to authored CommonJS, including
the coverage capture hook.

## Types, functions and review

The locked `strictTypeChecked` preset runs with `projectService: true`. Unsafe
assignments, arguments, calls, member access and returns are checked alongside
floating/misused promises. The compiler enables `noUncheckedIndexedAccess`,
`noImplicitReturns`, and `noFallthroughCasesInSwitch`.

`exactOptionalPropertyTypes` was assessed and remains false. Existing adapter
option compositions intentionally pass present `undefined` values: extension
exchange `cwd`/`timeoutMs`/`signal`, host cancellation signals, optional fixture
tools, and process-session state reset. Their current public behavior treats
absence and present `undefined` identically. Conditional object spreads would
obscure these compositions without strengthening external-input validation.
New contracts should describe absence and `undefined` deliberately.

Authored functions have a complexity ceiling of five, nesting depth three and
80 nonblank, noncomment lines. ESLint's modified cyclomatic variant counts a
switch as one decision; JavaScript logical operators, default arguments and
optional chains also count decisions. This is comparable in intent to Darrow's
Python ceiling of five, rather than a claim that the tools count identical
syntax. Numeric interpolation is allowed for useful bounded diagnostics; unsafe
or arbitrary object interpolation remains prohibited.

Named integration callbacks may use a documented, local function-length
exception to keep one fixture/invocation/assertion story together. The independent
`sevro/test-callback-lines` rule bounds every direct or chained Bun `test`/`it`
callback at 200 lines; helpers remain at 80 and complexity remains five.
[`typescript-test-callback-exceptions.json`](typescript-test-callback-exceptions.json)
records the exact assessed scenarios. The synchronous CommonJS capture hook has
one import-style exception because generated validators must retain normal CJS
loading; the discovery interop counterexample is retained in the evidence.

Review meaningful domain names, cohesive module ownership, focused operations,
validated external input, useful errors with retained causes, and assertions
against observable behavior. A reproducible bug requires a regression test.
Generated cases should exercise a meaningful parser, serialization,
normalization or lifecycle invariant. Fast-check properties use seed 20261007,
200 runs, and stop at the first failure; its failure output includes the seed
and replay path. Preserve those values when reproducing a failure.

## Coverage integrity

Istanbul instruments the original TypeScript AST before type erasure. Babel
composes transformation maps; `// @bun` preserves original stack locations.
CLI shebangs stay first and inserted marker lines adjust mappings. Generated
CommonJS follows normal loading and is never marked or passed through `onLoad`.

Each run clones independent Git metadata, copies the candidate, keeps an
unmodified source snapshot, and uses fresh report storage outside participant
workspaces. Production imports register capture even when a child changes
working directory. Bun teardown writes the test-runner completion; normal CLI
exit writes child completion. A ledger records participants and checks run ID,
layout, file scope, counter keys, nonnegative integer values, branch array lengths
and completion before merging. Every declared executable production file is
seeded with zero metadata without importing it to manufacture coverage.

Intentionally force-killed owned children use periodic conservative checkpoints.
The test preload declares the exact registered child killed by its parent.
Ordinary children still require completion; an undeclared or mismatched parent
cannot excuse a missing report. Missing checkpoints fail. No final counters are
estimated: a lost tail can lower coverage and cannot increase it. This retains
the real SIGKILL run-owner test and exempts no production file.

Statements and branches must each reach 95% using the exact covered/total ratio.
Rounded display percentages never determine success. Every generated file and
reachable validation success/refusal path remains in scope. The initial assessment in
[`typescript-generated-scaffolding-assessment.json`](typescript-generated-scaffolding-assessment.json)
identified 302 impossible false outcomes immediately after a compiler-local
error-counter copy. The narrower compiler-counter proof inventory was expanded
to 351 outcomes with no intervening counter write. Its source hashes and exact
AST locations are recorded in
[`typescript-coverage-exemptions.json`](typescript-coverage-exemptions.json).
[`typescript-generated-counter-proof.json`](typescript-generated-counter-proof.json)
retains the corresponding same-block AST proof findings and zero observations.
The current conservative analyzer combines that copy proof with private primitive
constant propagation: assignments invalidate facts, joins retain only identical
facts, terminated arms cannot reach joins, and loops invalidate written locals.
Lexical shadowing, captured-local closures, malformed syntax, dynamic evaluation
and unsupported statement forms decline proofs. It identifies 705 compiler-local
guard outcomes; wholly contained dead arms add 26 branch outcomes and 134
statements. The final deduplicated proposal covers 731 branch outcomes and 134
statements. It assumes no immutability of input JSON or its properties.

This exemption is proposed for independent Standards/Spec review; it is not
accepted merely because the implementation applies it. Enforcement retains the
raw Istanbul report and separately reports adjusted statement and branch denominators; it
never rewrites counters. A stale source/layout/analyzer proof or
an observed nonzero supposedly impossible outcome refuses the gate. An additional
357 required-presence outcomes remain counted: their immutability assumptions
have not received the required independent review. The reproducible analyzer is
in `scripts/coverage/compiler-flow.ts`, `compiler-counter-copy.ts` and
`compiler-exemptions.ts`. `bun scripts/coverage/generate-exemptions.ts` produces a
review candidate explicitly; schema regeneration does not refresh exemptions.
The gate rederives the exact sealed proof set, refuses a missing proof or nonzero
exempt statement/outcome, and checks analyzer hashes plus the TypeScript version.

Artifacts under `.quality/coverage` include the exact merged counters, baseline,
summary, process ledger, Bun test log, unmodified source snapshot, LCOV and HTML.
`enforcement.json` preserves both raw and adjusted exact counts, the explicit
guard/dead-arm reasons and the pending review status.
`--coverage [Bun test arguments]` is a diagnostic measurement; it still enforces
both thresholds and writes `.quality/coverage-targeted`, keeping it distinct from
the full-suite evidence. Sparse runs are expected to fail the full denominator.

The durable public probes are `--probe branch`, `--probe missing-reports`,
`--probe integrity`, `--probe source-map`, `--probe exemptions`, and
`--probe compiler-flow`. Branch and missing-report controls
deliberately exit 1. A five-of-five statement, one-of-two branch sample must fail
with `Below 95%: branches`. The integration suite retains real CLI/extension,
graceful SIGINT/SIGTERM cancellation, filesystem isolation and owned-child paths.

## Environment and CI

The discovery backend was observed with Bun 1.3.13, macOS arm64 and Node 24.13.0.
Implementation also ran on macOS arm64 (Darwin kernel 27.0.0). No additional Bun
version or operating system is claimed from that evidence. Hosted CI targets
`macos-26` arm64 with the same Bun/Node versions; its first successful hosted run
is required before describing that specific OS as validated. GitHub documents
the [macOS arm64 runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The existing macOS `sandbox-exec` prerequisite and isolation tests are retained.
Linux/Windows are not added as an unverified portable matrix.

CI invokes the canonical gate, uploads `.quality` even when coverage fails, and
publishes the stable aggregate `TypeScript quality` status. A cancelled, skipped
or failed gate cannot turn that status green.

[`typescript-coverage-discovery.json`](typescript-coverage-discovery.json) retains
the original machine-readable discovery record and digests. The selected
byte-preserved harness and observations are in `coverage-discovery/`; its retained
full artifact directory is identified by the original record. Those targeted
feasibility results are not a full-suite baseline or 95% acceptance evidence.

References: [Darrow's Python quality contract](https://github.com/BjRo/darrow/blob/main/docs/specs/python-quality.md),
[typescript-eslint presets](https://typescript-eslint.io/users/configs/),
[ESLint complexity semantics](https://eslint.org/docs/latest/rules/complexity).
