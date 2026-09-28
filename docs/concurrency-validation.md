# Trial concurrency validation

The public CLI preserves the positive `--jobs` contract required by Darrow's
extraction. Its default is three; the option bounds trials within one case.
Tests invoke the actual CLI and replace only the external candidate host with
synthetic adapters. No live model call was made.

## Observed test-first slice

Working directory: `/Users/bjro/Sources/sevro`.

Red — `lean-ctx -c 'bun test tests/cli-concurrency.test.ts -t "CLI bounds parallel trials and retains ordered isolated evidence"'`:
exit `64` because the public CLI did not accept `--jobs`.

Green — `lean-ctx -c 'bun test tests/cli-concurrency.test.ts -t "CLI bounds parallel trials and retains ordered isolated evidence"'`:
one test passed with 23 assertions. Five trials reach a peak of two active host
calls, retain separate workspaces and artifacts, and preserve trial-number order
in results, run evidence, and checkpoints. Every workspace is removed after
its trial artifact is retained.

The first implementation run reached the concurrency assertions but exposed
an incorrect temporary-path oracle: macOS canonicalized `/var` to `/private/var`.
The fixture now uses its canonical root; the original missing-option red remains
the test-first evidence.

## Additional guards

Four post-implementation guards cover cancellation of both active trials without
starting queued work; persistence failure that retains a completed peer before
diagnostic finalization and keeps the failed fixture; default three-job and
explicit serial execution with different configuration identities; and invalid
job limits before result or state storage is created. The complete file passed
five tests with 70 assertions. These guards do not claim an observed red.

Five prior internal tests require serial host-call order to bind expected trial
values, or a completed first trial before a later failure or cancellation.
They now request `jobs: 1` explicitly and retain their original assertions.
The first three focused repairs passed three tests with 25 assertions.
The combined command `lean-ctx -c 'bun test tests/engine.test.ts tests/claude-host.test.ts -t "runs trials, applies threshold|host artifacts are retained|host failure retains completed|cancellation retains prior|failed Claude execution"'`
passed all five serial tests with 51 assertions.

Final gates cover the full Sevro suite, types, formatting, installed-package
verification, and Darrow public-interface parity against the same tarball.
The bounded independent review retains its exact scope and checks outside the
repository. Dry or synthetic execution does not prove live-model stability.

## Review repairs

The independent review identified future-peer sandbox access, late admission
shutdown on errors, and cancellation before first admission. Each repair has
an observed public-CLI red and green in `/Users/bjro/Sources/sevro`.

Red — `lean-ctx -c 'bun test tests/cli-concurrency.test.ts -t "CLI retains interruption before admitting its first trial"'`:
SIGINT returned `70` instead of `130`.

Green — `lean-ctx -c 'bun test tests/cli-concurrency.test.ts -t "CLI retains interruption before admitting its first trial"'`:
one test passed with 20 assertions, covering SIGINT and SIGTERM, no host calls,
empty trial evidence, retained results, and interrupted ownership. The first
fixture sent its signal before CLI handlers existed and was corrected before
the recorded red; that process exit is not red evidence.

Red — `lean-ctx -c 'bun test tests/cli-concurrency.test.ts -t "CLI sandbox denies read and write access to later admitted peer fixtures"'`:
the real macOS sandbox allowed access to the later peer, failing the isolation
check with task exit `1`.

Green — `lean-ctx -c 'bun test tests/cli-concurrency.test.ts -t "CLI sandbox denies read and write access to later admitted peer fixtures"'`:
one test passed with four assertions. Trial one can use its own fixture while
its sandbox denies reading and writing trial three's marker; trial three keeps
the original content. The initial inline fixture produced an unrelated Git
metadata grading error. Using a declared generated Git fixture established the
recorded isolation red. Candidate and semantic roots are reserved before
execution. Peer roots are denied directly without querying Git metadata that
may still be under preparation.

Red — `lean-ctx -c 'bun test tests/cli-concurrency.test.ts -t "CLI closes queued admission when grading fails before advisory retention"'`:
four candidate calls started instead of two while the failing trial's advisory
work remained held.

Green — `lean-ctx -c 'bun test tests/cli-concurrency.test.ts -t "CLI closes queued admission when grading fails before advisory retention"'`:
one test passed with eight assertions. A required grader error closes admission
immediately; both admitted trials and advisory results remain retained.

A post-implementation guard also covers an execution failure with an already
active peer, retained trial artifacts, and completed ownership. It makes no red
claim. These repairs require fresh checks and verification of the original
closed finding set before committing.
