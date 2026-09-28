# Cache ownership validation

The public CLI's curated Claude runtime no longer supplies repository-specific
cache variables. Tools select their own defaults under an isolated home in the
trial's Git metadata. Candidate and shell-check homes are separate; their
curated UV cache is shared within one trial.

## Test-first trace

1. Red — `bun test tests/cli.test.ts -t "CLI curated Claude runtime leaves repository caches to tools"`:
   the synthetic Claude process rejected the injected `DARROW_CACHE_DIR`;
   the public result recorded failed execution and exit 2 instead of a passed
   task. Product code was unchanged.
2. Green — `bun test tests/cli.test.ts -t "CLI curated Claude runtime leaves repository caches to tools"`:
   one test passed after removing that override and placing the curated
   candidate home in Git metadata. An intermediate fixture correction
   canonicalized macOS path aliases before testing containment.
3. Red — `bun test tests/cli.test.ts -t "CLI curated shell grading leaves repository caches to tools"`:
   candidate execution completed, but the isolated shell check rejected the
   injected cache override and the public task failed. The shell grader was
   unchanged.
4. Green — `bun test tests/cli.test.ts -t "CLI curated shell grading leaves repository caches to tools"`:
   one test passed after removing the shell override. Intermediate test repairs
   corrected the public check status to `passed` and read checks from the
   documented CLI result, rather than a nonexistent evidence field.

The two commands remain the literal focused commands for these slices.
Intermediate fixture/assertion failures are not additional behavior evidence.
The candidate test supplies an unusable caller cache override and verifies
that it is absent from the host environment. Both tests write tool-owned cache
files. The shell test also verifies the curated cache, separate homes, and
an unchanged Git worktree.

## Final gates

- `bun run typecheck`
- `bun run format:check`
- `bun test`
- `bun run test:package-install`

The installation gate exercises the same environment migration through the
installed CLI, synthetic Claude executable, and an isolated shell check, with
no source Git metadata. Darrow separately runs its installed-package parity
gate against the exact candidate tarball.

These fixtures exercise Sevro's real preparation, execution, shell isolation,
grading, and package boundary. Claude is synthetic; this is not live model
evidence or proof of Claude's own sandbox behavior. No release is published by
these checks.
