# Tests

Run `bun test` from the repository root. Full acceptance, including instrumented
coverage and native isolation, uses `bun run check:typescript` and the required
GitHub CI phases described in [CONTRIBUTING.md](../CONTRIBUTING.md).

- `src/` mirrors the production `src/` tree. Files with several integration
  concerns use a source-module prefix and a concern suffix, such as
  `src/hosts/codex-host-preflight.test.ts`.
- `scripts/` exercises development tooling and quality gates.
- `guide/` contains the repository guide's host integration scenarios.
- `fixtures/` contains shared helpers and deterministic inputs, without test
  files. Production fixture tests live in `src/fixtures/`.

Use `createTemporaryFixtures` from `fixtures/filesystem.ts` to allocate and retain
temporary directories. Register `cleanupTemporaryFixtures` with `afterEach`, or
`afterAll` for a `beforeAll` fixture. Its optional prefix preserves special home
or private-namespace locations needed by isolation tests. Pass an existing roots
array when composing fixture factories, so the caller owns cleanup. Use
`fixtureGit` for fixture repositories; tests of the Git process API still call
that API directly.

Keep every test file in the explicit [source inventory](../typescript-sources.json).
After moving or splitting a file, update its
[duration estimate](../scripts/coverage/test-durations.json) so all CI shards use
the same layout and weights. Splits must retain their original scenarios and
assertions.
