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

The specification is being derived from all committed integration suites before
product implementation. Domain documents will map named test scenarios to their
public effects, expected results, negative controls, and platform constraints:

- CLI commands, settings, evaluation lifecycle, and concurrent admission.
- Runtime configuration, isolation, native hosts, observation and continuation.
- Extension negotiation, schemas, result states, reports, and identities.
- Fixture construction, setup, graders, retention, and ownership recovery.
- Installation, release provenance, documentation, guides, and quality gates.

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

The isolated worktree and behaviour-inventory assignments exist. The production
Rust implementation and Rust acceptance results are not yet present. Existing
TypeScript acceptance remains the reference baseline.
