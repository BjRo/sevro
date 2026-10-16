# Rust repository hook slices

This ledger records the bounded public CLI implementation of repository Git
hooks. Authority comes from the
[Git fixture contract](../extension-protocol-v1.md),
[development CLI](../development-cli.md), and
`repository overlays preserve source, index state, and metadata boundaries` in
[the TypeScript repository tests](../../tests/repository-fixture.test.ts).
The existing [generated-hook cohort](rust-tdd-generated-fixtures.md) supplies
the shared installer and validation; its passing tests are not evidence that
repository declarations already worked.

## Repository clone and candidate hook

The independent unchanged TypeScript CLI capture is
`/private/tmp/sevro-repository-hooks-oracle.8EHS7i/observation.json`. The probe
`/tmp/sevro-repository-hooks-oracle.mjs` creates an owned source repository with
one fixed `Initialize` commit, README bytes `source\n`, and an original source
hook that would exit 97. The direct case declares:

```json
{
  "sourceRef": "fixture-repo",
  "files": { "READY.txt": "new\n" },
  "hooks": {
    "pre-commit": "#!/bin/sh\necho 'hook blocked commit' >&2\nexit 1\n"
  }
}
```

The actual CLI selects that source through `--case-source-root` and a file-URL
source map. Its adapter stages `READY.txt`, attempts an actual commit, and
returns the observed process outcome, Git state and hook metadata as JSON.
The CLI completes and passes a valid-JSON output check. The candidate commit
exits 1, with empty stdout and stderr exactly `hook blocked commit\n`. The clone
remains detached at `46c49149aa29880bc2e54ffeb5270c7bc97329b6`; subject and fixed
author/committer remain unchanged. The index retains `A  READY.txt`, with staged
and working bytes `new\n`. The installed hook is a regular nonsymlink `0755`
file under umask `077`.

The fixture digest is
`da1686026d0d5de6860a04901afe1ad669a835085c3bb742cb325a2fb49ee0e7`.
The source retains its original HEAD, `main` branch, clean status, README, hook
bytes and `0700` hook mode. The overlay does not appear in the source. The
successful candidate workspace is removed, while run and raw-result evidence
remain available.

- Red — `cargo test -p sevro --test run_repository --locked hooks::installs_declared_repository_hooks_without_changing_the_source -- --exact`:
  the unchanged Rust implementation compiled and returned 64 because `hooks`
  was an unknown repository declaration field.
- Green — `cargo test -p sevro --test run_repository --locked hooks::installs_declared_repository_hooks_without_changing_the_source -- --exact`:
  1 passed after preserving the hook map through declaration parsing,
  validation, source resolution and fixture identity, then installing it after
  cloning and overlay/staging. The test checks the complete independent host
  receipt, fixed digest, source snapshot and successful workspace cleanup.

The shared tools module is unchanged. Repository hooks use the same validated
names, content limits, target-type checks and explicit executable mode as
generated hooks. Installation remains before the existing setup/artifact path.
The schema owner's lazy `SchemaPreparation` and `sevro.schema` attachment are
preserved without modification.

## Explicit null and adjacent declaration controls

The actual TypeScript CLI captures under
`/private/tmp/sevro-repository-hook-controls.cS1oIu` are produced by
`/tmp/sevro-repository-hook-controls.mjs`. Each input has its own exact command,
public result and retained summary. Invalid hook maps return 64 with the named
case-file diagnostic containing `invalid fixture hooks`, without admitting
results storage.

- Red — `cargo test -p sevro --test run_repository --locked hooks::refuses_null_repository_hooks_before_run_admission -- --exact`:
  optional-field deserialization erased `hooks: null`; the case executed and
  passed with exit 0.
- Green — `cargo test -p sevro --test run_repository --locked hooks::refuses_null_repository_hooks_before_run_admission -- --exact`:
  1 passed after the existing direct-case hook-map shape check also selected
  repository declarations, before deserialization could erase explicit null.
  The test compares the complete unassessed JSON refusal, absence of results
  storage, and unchanged source snapshot.

Each following control passed on its first invocation without a product change.
These are characterizations, not claimed behavioral reds:

- `cargo test -p sevro --test run_repository --locked hooks::refuses_escaping_repository_hook_names_before_run_admission -- --exact`:
  `../escape` is refused by the shared validator, with the exact named case-file
  diagnostic, no results directory and an unchanged source.
- `cargo test -p sevro --test run_repository --locked hooks::names_malformed_repository_hook_maps_before_run_admission -- --exact`:
  array declarations and nonstring contents receive the same precise refusal.
- `cargo test -p sevro --test run_repository --locked hooks::distinguishes_omitted_and_empty_repository_hooks_in_fixture_identity -- --exact`:
  both valid selections execute successfully and preserve the source, while
  omitted hooks have digest
  `fc8232ab9de233211674a7b5e43b716fccd4425db6e042c97185ff717d28e5e7`
  and explicit `{}` has digest
  `0f7c88ebe06f7dc5b3ef7b56e5162d5e3f538b12c3757da407d2c06d92baa353`.

## Cohort boundary

The new public tests live in `tests/run_repository/hooks.rs` and are registered
by the existing repository integration target. Production changes are confined
to repository declaration/validation in `run/preparation.rs` and carrying,
hashing and installing that declaration in `run/fixtures.rs`. The shared
`run/fixtures/tools.rs`, source-cloning code, generated implementation, schema
grader, host, records, native runtime and dependencies are unchanged by this
cohort.

Fixture binaries, committed repository scaffolding and dedicated extension
setup-order controls remain separate work. This cohort does not duplicate the
shared installer's complete generated-fixture safety matrix or claim Linux,
full-suite or compiler-coverage acceptance. Local commands use the pinned
toolchain and `CARGO_TARGET_DIR=/tmp/sevro-generated-target.jMxLbl` through
`lean-ctx`. Publication and combined acceptance remain coordinator-owned.

Final scoped checks passed:

- `cargo test -p sevro --test run_repository --locked hooks::`: all 5 hook tests
  passed with default parallelism; 59 unrelated tests were filtered.
- `cargo test -p sevro --test run_repository --locked overlay::`: all 10 selected
  overlay/staging controls passed; 54 unrelated tests were filtered.
- `cargo test -p sevro --test run_repository --locked preparation`: all 22
  selected preparation/artifact controls passed; 42 unrelated tests were filtered.
- `cargo test -p sevro --test run_generated --test run_dry --locked`: all 22
  generated tests and the inline dry test passed.
- `cargo test -p sevro --test run_graders --locked standalone_schema_passes_a_matching_inline_object -- --exact`:
  the existing ordinary schema success control passed; 122 unrelated tests were
  filtered. This verifies preservation of the newly attached schema path without
  claiming the schema owner's complete cohort.
- `cargo clippy -p sevro --lib --test run_repository --test run_generated --test run_dry --locked -- -D warnings`.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/src/run/preparation.rs crates/sevro/src/run/fixtures.rs crates/sevro/tests/run_repository.rs crates/sevro/tests/run_repository/hooks.rs`.
- `bunx prettier --write docs/specs/rust-tdd-repository-hooks.md` and
  `bun run check:docs`.
