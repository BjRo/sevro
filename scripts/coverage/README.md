# Coverage tooling

This folder measures authored production code while running the real Bun test
suite and its CLI/extension subprocesses. The canonical entrypoint is
[`scripts/check-typescript.ts`](../check-typescript.ts).

Run these commands from the repository root:

```sh
bun run check:typescript
bun run check:typescript --coverage tests/cli.test.ts
```

The first command runs the complete quality gate. The second is a diagnostic
coverage run for selected tests; it still enforces both 95% thresholds against
the platform-reachable authored production inventory, so a narrow run can fail
the gate.
`--fast` skips coverage and the full integration suite.

## Pipeline and files

1. Copy the current candidate into an isolated checkout with independent Git
   metadata and retain an unmodified source snapshot.
2. Instrument the declared platform-reachable authored TypeScript files before
   erasing their types, compose source maps, and seed each with zero counters.
3. Run Bun tests and capture counters from each participating process.
4. Validate and merge reports, write coverage artifacts, and enforce statement
   and branch coverage independently using exact counts.

| File                                         | Responsibility                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [prepare.ts](prepare.ts)                     | Candidate copying, instrumentation, source maps and the zero-count baseline.                                  |
| [platform-scope.ts](platform-scope.ts)       | Explicit macOS/Linux unreachable module lists; all files remain in the checked production inventory.          |
| [platform-branches.ts](platform-branches.ts) | Static proof of OS-impossible branch outcomes after raw reports have passed integrity checks.                 |
| [capture.cjs](capture.cjs)                   | Process registration, periodic counter checkpoints and exit-time completion.                                  |
| [test-preload.ts](test-preload.ts)           | Bun test teardown capture and declarations for intentionally force-killed owned children.                     |
| [records.ts](records.ts)                     | Validation of report objects, identities and counter values.                                                  |
| [gate.ts](gate.ts)                           | Validation of scope/layout/completion, safe report merging and threshold checks.                              |
| [run.ts](run.ts)                             | Test execution, report collection, foreign-working-directory check and artifact generation.                   |
| [types.ts](types.ts)                         | Shared report and capture types, including the coverage globals.                                              |
| [probes.ts](probes.ts)                       | Controls for missing/stale reports, missing branch data, zero seeding and conservative force-kill collection. |
| [scope-probe.ts](scope-probe.ts)             | Checks authored coverage scope and normal loading of excluded generated validators.                           |
| [source-map-probe.ts](source-map-probe.ts)   | Checks that counters and runtime stacks point to original TypeScript.                                         |
| [snapshot-probe.ts](snapshot-probe.ts)       | Checks exact candidate inputs, deletions and isolated Git metadata.                                           |

The ES modules use TypeScript and Bun's native TypeScript loading. `capture.cjs`
is the sole CommonJS exception: instrumented modules and the test preload share
its synchronously initialized process-capture handle. Its JSDoc references the
shared TypeScript types, and it remains linted and typechecked.

## Scope and artifacts

[`typescript-sources.json`](../../typescript-sources.json) declares the checked
source inventory. Coverage counts every platform-reachable authored production
file, including unimported files. Ubuntu excludes the macOS sandbox and Keychain
modules; macOS excludes the Linux sandbox module. Shared code remains covered
on both platforms. Branch outcomes made impossible by a static
`process.platform` condition are omitted after raw report validation; any
nonzero excluded counter fails. Reachable outcomes stay in the denominator.
The five generated AJV validators load normally and stay
outside the coverage denominator; schema freshness, declarations and runtime
validation still check them. Tooling, tests and fixtures are also outside that
denominator.

Full runs write `.quality/coverage`; diagnostic runs write
`.quality/coverage-targeted`. These ignored directories retain the source
snapshot, baseline, process ledger, test log, merged counters, exact enforcement
summary with the explicit platform scope, raw preprojection counters, LCOV and
HTML. Missing or incompatible
reports fail collection. An
explicitly owned SIGKILL may use a validated checkpoint, which can undercount
the lost tail but never invent coverage.

See the [TypeScript quality contract](../../docs/typescript-quality.md) for the
source dispositions, thresholds and supported environment.
