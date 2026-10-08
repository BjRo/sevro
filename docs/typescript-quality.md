# TypeScript quality

`bun run check:typescript` is the local and CI acceptance command. It performs a
frozen dependency installation, checks the complete source inventory, verifies
generated schemas, documentation contracts, formatting, type-aware lint and typing,
checks the Codex guide evaluation in dry mode and runs documentation examples, exercises coverage
integrity controls, runs the deterministic Bun suite in an isolated instrumented
copy, enforces statements and branches independently, and validates installation
of the published package. Runtime dependencies and public evaluation semantics
remain part of the existing package-install contract.

Use `bun run check:typescript --fast` before committing. It checks inventory,
schemas, documentation contracts, formatting, lint and types without the full integration suite, coverage
or package installation. Install dependencies with `bun install --frozen-lockfile`
first. Quality dependencies are development dependencies pinned in `bun.lock`.

## Source dispositions

[`typescript-sources.json`](../typescript-sources.json) explicitly lists every
TypeScript and JavaScript source. The guard refuses new, missing or duplicated
files and declarations outside the configured TypeScript project. Changing a
source disposition requires review; adding a glob is not a substitute for the
inventory. The coverage baseline includes exactly `inventory.production`, whose
current instrumentation supports authored `.ts`. The five exact generated
validators in `inventory.generated` are excluded from instrumentation and the
coverage denominator. New `.tsx`, `.mts`, `.cts` or JavaScript
production requires an explicit instrumentation and quality-policy change first.

| Inventory      | Lint and typing                                                                                      | Test and coverage disposition                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production`   | Type-aware strict lint and strict compiler                                                           | All authored executable `src` statements and branch outcomes in the declared inventory, including unimported files                                                                                   |
| `generated`    | CommonJS syntax parsing, exact `schemas:check` freshness, and checked `.d.cts` boundary declarations | Real Bun schema tests; the five declared generated validators are outside the coverage denominator                                                                                                   |
| `declarations` | Type-aware lint and compiler                                                                         | Declaration-only files have no executable counters                                                                                                                                                   |
| `tooling`      | Same type-aware lint and strict compiler; `.mjs`/`.cjs` use `checkJs` and explicit JSDoc contracts   | Durable public gate probes, schema freshness, release and installed-package tests; outside the runner-production denominator                                                                         |
| `tests`        | Same type-aware lint and strict compiler, including fixtures                                         | Real Bun filesystem/process/protocol tests; outside the production denominator                                                                                                                       |
| `examples`     | Same type-aware lint and strict compiler                                                             | Packaged demonstration host adapters are synthetic consumer fixtures, exercised by installed-package validation; they implement no runner behavior and are outside the runner-production denominator |

Generated AJV CommonJS is deliberately not rewritten to conform to authored-code
rules. An earlier audit of the original four generated files using ESLint's
recommended JavaScript rules found 879 redeclarations, 281 useless assignments, 182 unused variables and
108 unreachable-code findings. Those are generator emissions. Their syntax,
generation freshness, typed public boundaries and runtime behavior remain checked.
Generated compiler output is excluded from coverage because the coverage target
measures authored runner behavior. This applies only to
`src/generated/cli-result.cjs`, `extension.cjs`, `report.cjs`, `run-evidence.cjs` and `runtime.cjs`
as explicitly declared in the inventory. This disposition does not apply to authored CommonJS, including
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
Each exception is explained in an ESLint comment beside the affected test.
The maintained CommonJS capture hook has
one import-style exception for its synchronous Node filesystem/path `require`
calls. Instrumented authored modules import it to register process capture; the
Bun test preload uses its exported handle to flush completion at teardown. The
discovery interop counterexample remains historical evidence.

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

Statements and branches must each reach 95% using the exact covered/total ratio
over the complete declared authored production inventory. Rounded display
percentages never determine success. The gate enforces raw counters without
compiler exemptions, adjusted denominators or counter rewriting. It validates
source classifications before preparing coverage, including direct `--coverage`
runs, so unregistered authored TypeScript or CommonJS, missing sources and
overlapping dispositions refuse the gate. Generated validators retain normal
CommonJS loading, schema freshness checks and real schema/runtime tests.

Artifacts under `.quality/coverage` include the exact merged counters, baseline,
summary, process ledger, Bun test log, unmodified source snapshot, LCOV and HTML.
`enforcement.json` records the authored production scope and raw exact counts.
`--coverage [Bun test arguments]` is a diagnostic measurement; it still enforces
both thresholds and writes `.quality/coverage-targeted`, keeping it distinct from
the full-suite evidence. Sparse runs are expected to fail the full denominator.

The durable public probes are `--probe snapshot`, `--probe scope`, `--probe branch`,
`--probe missing-reports`, `--probe integrity`, and `--probe source-map`.
The scope probe records a zero-seeded baseline and merged real process report
under `.quality/coverage-scope`; it verifies that ordinary generated CommonJS
validation still runs. Branch and missing-report controls
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

The [coverage tooling README](../scripts/coverage/README.md) explains the maintained
pipeline and file responsibilities. Fresh CI reports provide candidate-specific evidence.

References: [Darrow's Python quality contract](https://github.com/BjRo/darrow/blob/main/docs/specs/python-quality.md),
[typescript-eslint presets](https://typescript-eslint.io/users/configs/),
[ESLint complexity semantics](https://eslint.org/docs/latest/rules/complexity).
