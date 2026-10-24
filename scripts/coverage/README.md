# Coverage tooling

This folder measures authored production code while running the real Bun test
suite and its CLI/extension subprocesses. The canonical entrypoint is
[`scripts/check-typescript.ts`](../check-typescript.ts).

Run these commands from the repository root:

```sh
bun run check:typescript
bun run check:typescript --coverage tests/src/cli/results.test.ts
```

The first command runs the complete quality gate. The second is a diagnostic
coverage run for selected tests; it still enforces both 95% thresholds against
the platform-reachable authored production inventory, so a narrow run can fail
the gate.
`--fast` skips coverage and the full integration suite.

## Test shards

CI runs four independent test shards, followed by one combined coverage gate:

```sh
bun run check:typescript --shard-plan
bun run check:typescript --shard 1/4
bun run check:typescript --shard 2/4
bun run check:typescript --shard 3/4
bun run check:typescript --shard 4/4
bun run check:typescript --merge-shards
```

After frozen installation, the four shard commands can run concurrently. They
write distinct `.quality/shards/<index>/` directories. Each validates its real
process reports and requires successful test execution. Only `--merge-shards`
enforces the two 95% thresholds; partial coverage cannot establish acceptance.
The test suite invokes each coverage integrity probe once through
`tests/scripts/typescript-quality.test.ts`; the combined command validates shard evidence
and coverage without rerunning those probes.

Assignments use the complete checked test inventory, with each file present
exactly once. [`test-durations.json`](test-durations.json) records rounded seconds
from the successful Ubuntu run [38747270730](https://github.com/BjRo/sevro/actions/runs/38747270730),
with the former guide matrix divided by host and positive/negative scenarios.
For #145, the Claude negative weight is rescaled from 141 to 62 seconds using
the measured before/after ratio documented in [guide evaluation](../../docs/guide-evaluation.md).
For #146, moved files retain their weights; the four split suites divide their
previous weight among their new files in proportion to top-level test declarations,
rounded to at least one second per file. These are scheduling estimates, not new
timing measurements. The remaining weights retain their original measurements.
The longest files are assigned first to the lightest shard; ties are resolved
deterministically by path and shard order. New files default to five seconds.
Update estimates from retained `tests.log` durations when the workload changes;
every job in a run must use the same checked-in estimates and source inventory.

Aggregation requires all four manifests, unique shard/run identities, the exact
expected assignments, matching candidate contents and workflow run, and
the same OS, architecture, Bun version and instrumentation layout. It validates
the full zero-seeded source inventory, locations and counters again after
normalizing paths. Process ledgers remain separate so repeated PIDs on different
runners cannot overwrite evidence. Raw counters are merged before platform
projection and threshold enforcement. Outside GitHub Actions, the batch identity
is `local`; rerun all four shards after changing candidate inputs. GitHub's
failed-job reruns reuse passing artifacts from earlier attempts of the same run;
each rerun replaces its own named shard artifact. The manifest retains the
producing attempt, and artifacts from another workflow run remain incompatible.

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
| [shard-plan.ts](shard-plan.ts)               | Deterministic duration-balanced assignment of the complete test inventory.                                    |
| [shard-output.ts](shard-output.ts)           | Portable source paths and candidate-bound shard manifests.                                                    |
| [shard-merge.ts](shard-merge.ts)             | Complete-shard, identity, assignment, source-layout and counter validation.                                   |
| [aggregate.ts](aggregate.ts)                 | Combined coverage artifacts, platform projection and the unchanged 95% thresholds.                            |
| [probes.ts](probes.ts)                       | Controls for missing/stale reports, missing branch data, zero seeding and conservative force-kill collection. |
| [scope-probe.ts](scope-probe.ts)             | Checks authored coverage scope and normal loading of excluded generated validators.                           |
| [source-map-probe.ts](source-map-probe.ts)   | Checks that counters and runtime stacks point to original TypeScript.                                         |
| [snapshot-probe.ts](snapshot-probe.ts)       | Checks exact candidate inputs, deletions and isolated Git metadata.                                           |

The ES modules use TypeScript and Bun's native TypeScript loading. `capture.cjs`
is the sole CommonJS exception: instrumented modules and the test preload share
its synchronously initialized process-capture handle. Its JSDoc references the
shared TypeScript types, and it remains linted and typechecked.

## Scope and artifacts

The [Git-derived inventory guard](../typescript-inventory.ts) classifies the checked
source inventory using the reviewed path rules and exact generated-validator
catalog. Coverage counts every platform-reachable authored production
file, including unimported files. Ubuntu excludes the macOS sandbox, Keychain,
and Darwin-only Apple metadata module, whose public caller has an explicit
platform guard. macOS measures that metadata module; shared provider/query/path
code remains measured on both platforms. Both still lint and typecheck the complete
source inventory. The macOS gate is local-only; hosted CI runs on Ubuntu.
macOS excludes the Linux sandbox module. Branch outcomes made impossible by a static
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
