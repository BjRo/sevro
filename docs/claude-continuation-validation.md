# Claude continuation validation

The bundled Claude host now starts and resumes the same UUID-bound native
session for a declared follow-up prompt. The public CLI regressions use
synthetic executables and credentials without model calls.

Working directory: `/Users/bjro/Sources/sevro`.

## Public CLI slices

1. Red — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI resumes Claude in the same isolated session and grades its final turn"'`:
   exit `64`, with `selected host does not support continuation`.
2. Green — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI resumes Claude in the same isolated session and grades its final turn"'`:
   one test passed with eight assertions. Both calls use the same native
   session, settings, credentials, model, and effort. The final response passes;
   separate turn artifacts, combined usage, and the workspace boundary remain
   in public evidence. A later guard also confirms exactly one initial and one
   resume launch, bringing this test to nine assertions.
3. Red — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI leaves Claude usage unmeasured when a resumed result belongs to another session"'`:
   foreign-session usage was incorrectly retained as complete with four input
   tokens, six output tokens, and cost `0.03`.
4. Green — `lean-ctx -c 'bun test tests/cli.test.ts -t "CLI leaves Claude usage unmeasured when a resumed result belongs to another session"'`:
   one test passed with three assertions. Execution fails, task success is
   unassessed, and unbound token and cost measurements remain unknown.

The first test initially omitted the generated fixture's `kind`. Its invalid
configuration was corrected before the meaningful red above; that setup error
was not a missing-behavior red.

## Additional guards and final gates

Two additional CLI guards passed with 62 assertions. They cover failed,
missing, foreign, and duplicate native results in either turn, prevent resume
after an invalid initial result, retain failed event evidence without grading,
and preserve changed, unmeasured, or incomplete usage observations. They were
added after implementation, without a test-first claim. One initial assertion
used the wrong retained-check location; it was corrected to the public CLI
trial checks.

The full `lean-ctx -c 'bun test'` gate passed 210 tests with 1,131 assertions
across 36 files in 67.67 seconds. Typechecking and formatting passed.
`lean-ctx -c 'bun run test:package-install'` installed Sevro `0.1.0-dev.0`
without source Git metadata and passed its public-command checks.

These results verify the implementation and deterministic failure boundaries.
A live continuation and Darrow's installed-package integration are recorded
separately when observed. This remains an unpublished development version.
