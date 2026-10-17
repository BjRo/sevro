# Rust port acceptance

This specification tracks the requested production port of Sevro to Rust while
preserving existing features. It starts from Sevro `main` at
`1400f3f` (package `0.1.0-rc.15`). The current integration tests and
[public contracts](../contracts.md) supply the behavioural oracles.
[Issue #2](https://github.com/BjRo/sevro/issues/2) supplies research findings;
its earlier bounded prototype is not evidence that the port is implemented.

## Compatibility boundary

The replacement must execute the complete evaluation lifecycle in Rust. It must
retain the installed `sevro` command, current commands and configuration, generic
and project extension workflows, native Codex and Claude hosts, fixture setup,
all graders, evidence and result semantics, reporting, concurrency, cancellation,
recovery, and installation. Existing TypeScript adapters need a working transition
path; merely rejecting them is a regression. Project case and evaluator policy
continues to belong to extensions, including Darrow.

Current CLI, protocol, configuration, schema, and persisted artifact contracts
remain acceptance seams. Internal TypeScript module structure is not a required
Rust architecture. A temporary compatibility process may load existing adapters,
but it cannot substitute for Rust ownership of the runner lifecycle. Removing a
capability or changing a public contract requires an explicit documented decision;
an easier passing subset does not establish completion.

macOS and Ubuntu 24.04 x64 are required. Preserve credential isolation, evaluator
input containment, bounded observations, process and descendant cleanup, atomic
private evidence, run ownership, and unavailable/ambiguous evidence handling.
Missing evidence must never become a successful assessment.

## Behaviour inventory

Five domain references map the baseline integration suites to public effects,
independent expected results, negative controls, and platform constraints:

- [CLI and evaluation engine](rust-cli-engine-parity.md): commands, settings,
  lifecycle, concurrent admission, cancellation, and user workflows.
- [Runtime and native hosts](rust-runtime-hosts-parity.md): configuration,
  isolation, credentials, observations, sessions, continuation, and hooks.
- [Protocol and results](rust-protocol-results-parity.md): extension negotiation,
  schemas, result states, reports, canonical identities, and provenance.
- [Fixtures and graders](rust-fixtures-graders-parity.md): construction, setup,
  all graders, advisory review, retention, and ownership recovery.
- [Delivery and tooling](rust-delivery-parity.md): installation, release
  provenance, documentation, guides, properties, and quality gates.

All 109 baseline `tests/**/*.test.ts` files have a reference in these documents.
Each reference preserves parameterized test families and their source matrices;
declaration counts are not executed-test counts. Cross-cutting suites appear in
more than one domain. Relevant public contracts and source-derived constraints
supplement the tests where their examples are narrower than the contract.

Coverage of a test file means its assertions have been inventoried. It does not
mean the Rust implementation passes those assertions. Implementation evidence
will be recorded separately, with explicit remaining gaps.

## Test-first implementation

Implement successive vertical slices through existing public CLI, extension,
and artifact seams. Each slice records an independent oracle, a focused command
that fails because the required behaviour is absent, the smallest corresponding
Rust implementation, and a pass from that identical command. Compilation errors
and unavailable tools do not count as behavioural red evidence. Keep the original
integration suite intact during migration, and add Rust subprocess integration
tests or run compatible existing scenarios against the compiled executable.

Use cohesive Rust modules, typed states and validated input, explicit errors,
and established crates where they preserve the required semantics. Use rustfmt,
Clippy, Cargo tests and compiler-supported coverage tooling; do not recreate the
custom Bun instrumentation pipeline in Rust.

## Delivery evidence

The draft PR is updated at meaningful milestones. Every published candidate must
retain its source commit and observed checks. The existing four TypeScript quality
phases remain required while that implementation is present. Rust acceptance must
exercise build, formatting, lint, tests, coverage and installed execution on both
required platforms, including failure, cancellation and cleanup paths. Historical
research measurements cannot substitute for current candidate evidence.

Completion requires a feature-by-feature audit against this specification and its
source tests, successful required GitHub CI for the exact published commit, and
an installed Rust runner exercising the supported workflows. Keeping the draft
open, passing a small Rust suite, or leaving the TypeScript runner as the actual
engine does not satisfy the requested port. Registry publication and PR merging
are separate maintainer actions.

## Current state

The behaviour inventory is complete by source-file accounting. The first Rust
implementation covers these public seams:

- CLI help, version, and invalid-command output, with
  [CLI TDD evidence](rust-tdd-cli.md).
- The packaged deterministic demo and its owned temporary inputs, with
  [demo TDD evidence](rust-tdd-demo.md).
- All three initializer templates and destination safety, with
  [initializer TDD evidence](rust-tdd-init.md).
- Retained-result JSON and Markdown reports, published schema validation,
  evidence consistency, and measurement semantics, with
  [report TDD evidence](rust-tdd-report.md).
- Dry evaluation preparation, canonical identities, and retained evidence, with
  [dry-run TDD evidence](rust-tdd-run-dry.md).
- Saved run settings and explicit CLI selection precedence, with
  [run-options TDD evidence](rust-tdd-run-options.md).
- Plain-text run summaries, failed-check details, and retained measurements, with
  [console TDD evidence](rust-tdd-run-console.md).
- Existing TypeScript adapters through an invocation-wide compatibility process,
  with [adapter TDD evidence](rust-tdd-adapters.md).
- Extension discovery, case resolution, and preparation, with
  [extension TDD evidence](rust-tdd-extension.md).
- Repository fixture preparation and mapped-worktree isolation, with
  [fixture TDD evidence](rust-tdd-fixtures.md) and
  [preparation-artifact boundary evidence](rust-tdd-preparation-artifacts.md).
- Generated fixture executables and setup PATH precedence, with
  [fixture-bin TDD evidence](rust-tdd-fixture-bin.md).
- Selected source-map validation before execution, with
  [source-map input evidence](rust-tdd-source-maps.md).
- Fixture setup deadline, descendant cleanup, and failed-workspace retention,
  with [setup-deadline TDD evidence](rust-tdd-setup-deadline.md).
- Project content snapshots and Git provenance, with
  [provenance TDD evidence](rust-tdd-provenance.md).
- Isolated native Codex execution and passive continuation, plus initial passive
  Claude execution with explicit binary and credential selection, with
  [native-host TDD evidence](rust-tdd-native-hosts.md).
- Exact-output, JSON-document, JSON-path, and initial regular-expression grading, with
  [grader TDD evidence](rust-tdd-graders.md).
- Required-evidence assessment using retained artifacts and built-in observations,
  with [required-evidence TDD evidence](rust-tdd-required-evidence.md).
- Receipt bounds and partial evidence preservation after persistence failure,
  with [receipt TDD evidence](rust-tdd-receipts.md).
- Mixed trial outcomes and admission after host failure, with
  [result TDD evidence](rust-tdd-results.md).
- Cleanup of permission-locked workspaces and result-publication failures, with
  [storage TDD evidence](rust-tdd-storage.md).
- Independent retained-result and ownership roots, with
  [state-root TDD evidence](rust-tdd-state-root.md).

Each implementation ledger identifies its tested boundary and remaining gaps.
These initial evaluation slices do not establish complete lifecycle parity.
The [core error refactor evidence](rust-refactor-run-error.md) records preserved
CLI diagnostics and retained internal causes against the existing regressions.
The [typed preparation handoffs](rust-refactor-preparation.md) remove repeated
decoding while preserving validation order, identities, and filesystem checks.

The [Rust quality contract](rust-quality.md) adds compiler coverage and installed
binary checks on macOS and Ubuntu. Stable line and region gates accompany a
pinned nightly gate for LLVM's supported branch outcomes; the contract records
the compiler's measured construct limits. Existing TypeScript acceptance remains
the reference baseline; full Rust feature parity is not established.
The complete production evaluation lifecycle, native hosts, isolation, grading,
recovery, extension evaluation, and installed replacement still require Rust
implementation and acceptance evidence. The existing npm command continues to use
the TypeScript implementation during this migration.
