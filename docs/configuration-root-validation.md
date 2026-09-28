# Configuration root validation

The public CLI imports one explicit Codex setting from a separate configuration
root, binds each used role's effective value into retained configuration and
evaluation identity, and protects that repository's primary and linked worktrees.
The runtime TOML dependency is pinned to `smol-toml` 1.8.0.

Working directory: `/Users/bjro/Sources/sevro`.

## Observed test-first slices

1. Red — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI imports only the Codex limit from its separate configuration root"'`:
   exit `64`, `sevro.invocation.invalid`, because `--config-root` was unsupported.
2. Green — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI imports only the Codex limit from its separate configuration root"'`:
   one test passed with eight assertions. The synthetic Codex process requires
   the imported limit in its isolated configuration and rejects an unrelated
   model marker. Changed limits are retained and change evaluation identity.
3. Red — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI isolates a separate configuration repository and its linked worktree"'`:
   task exit `1`; the primary configuration secret was denied, but the linked
   worktree secret remained readable by the isolated shell grader.
4. Green — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI isolates a separate configuration repository and its linked worktree"'`:
   one test passed with three assertions; both protected-source reads fail.
5. Red — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI refuses a dangling Codex configuration link before execution"'`:
   incorrectly returned `0` for a declared unreadable configuration link.
6. Green — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI refuses a dangling Codex configuration link before execution"'`:
   one test passed with three assertions; exit `64`, execution `not_run`.

Before implementation, the first test's identity assertion was corrected to
read `evaluationIdentity.digest` from retained evidence rather than an absent
CLI result field. The second test's check status oracle was also corrected
from `pass` to the documented `passed` before implementation. Both literal red
commands were rerun and still failed for the missing product behavior above.

Additional guards were added after implementation without a test-first claim.
They cover missing files and settings, all three Codex roles, malformed TOML,
non-table agent settings, invalid numeric types and ranges, a non-file config,
and relative, missing, or non-directory configuration roots. Together the five
new tests contain 65 assertions. No live model call is involved; macOS isolation
tests use the installed Codex sandbox and a synthetic candidate executable.

## Test timeout repair

The first full `bun test` gate completed 214 tests and timed out the existing
eight-scenario Claude continuation guard after its default five seconds. Timeout
cleanup removed its active fixture, producing a subsequent ownership diagnostic.
The test now has an explicit ten-second bound, with every assertion unchanged.
`lean-ctx -c 'bun test tests/cli.test.ts -t "Claude continuation never grades failed or unbound native results"'`
then passed one test with 52 assertions in 3.96 seconds. This is test harness
maintenance, without a product-behavior red/green claim.

## Independent review repairs

The bounded independent review found two medium blocking findings: a dangling
intermediate `.codex` directory link was treated as absent configuration, and
an explicitly empty `--config-root` silently selected the project root. The
original candidate-bound report is retained at
`/Users/bjro/.darrow/reviews-issue95-configuration-root/8794a1ce3463a83e1434abc110042a76e2397e27951a9a5cbf42214d9bbfc77b/darrow-review.k328difz/review.md`.

1. Red — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI distinguishes absent Codex configuration from a dangling directory link"'`:
   returned `0` for the unreadable declared directory link; absent and ordinary
   empty directories already retained the null host default.
2. Green — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI distinguishes absent Codex configuration from a dangling directory link"'`:
   one test passed with seven assertions; the link fails with `64`, execution
   `not_run`, and an absolute configuration-path diagnostic.
3. Red — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI rejects an explicitly empty configuration root"'`:
   returned `0` when the supplied empty option should fail.
4. Green — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI rejects an explicitly empty configuration root"'`:
   one test passed with four assertions for both separate and equals option
   forms; each returns `64` and execution `not_run`. Omission still defaults
   to the project root through the existing retained-role guards.
