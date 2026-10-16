# Repository staged overlays

This ledger ports declared repository overlay staging through the public
extension/native dry-run CLI. It does not add committed scaffolding, hooks,
fixture executables, or new generated-fixture behavior.

The [extension contract](../extension-protocol-v1.md) permits staged Git fixture
paths and requires setup after history and working-tree preparation. The
TypeScript [repository declaration and materialization](../../src/fixtures/repository.ts)
validate staging against the overlay, count staging path bytes, and run Git add
with hooks disabled. Existing integration test
`repository overlays preserve source, index state, and metadata boundaries` in
[repository-fixture.test.ts](../../tests/repository-fixture.test.ts) asserts the
staged/untracked distinction and unchanged source revision.

Commands use the pinned toolchain and
`CARGO_TARGET_DIR=/Users/bjro/.codex/artifacts/sevro-repository-staging-20261016/target`.
Independent TypeScript captures are retained outside the checkout under
`/Users/bjro/.codex/artifacts/sevro-repository-staging-20261016/`.

## Slice 1: stage only declared overlay paths before setup

Oracle — `python3 /tmp/sevro-repository-staging-oracle.py`: the unchanged
TypeScript public CLI returned 0 for a real extension declaring README and notes
overlays, `staged: ["README.md"]`, and negotiated setup. Setup verified the
literal index bytes, `M  README.md` and `?? notes.txt` status, original HEAD,
and absent remotes. Its completion receipt was `staged overlay verified\n`.
Dry-run evidence reported `not_run`, `not_requested`, and `not_assessed`; no
native host ran and the workspace was removed. Source README, raw index,
reference, revision, and clean status were preserved. Exact argv, extension,
setup, responses, stdout/stderr, evidence, and summary are under `typescript/`.

Red — `cargo test --offline --locked -p sevro --test run_repository overlay::stages_only_declared_repository_overlay_paths_before_setup -- --exact`:
the new public test compiled, then failed because Rust returned 64,
`invalid case file: unknown field staged, expected one of kind, files, sourceRef`,
instead of the independently observed 0. Production code was unchanged.

The repository declaration and prepared snapshot now preserve optional staged
paths. Fixture identity includes the field only when declared. After writing
the clone's overlay, materialization runs bounded Git add with `--` and disabled
hooks, before the existing setup/artifact sequence. Generated declarations,
their exact-deduplicated history paths, Git classification, and null validation
remain unchanged.

Green — `cargo test --offline --locked -p sevro --test run_repository overlay::stages_only_declared_repository_overlay_paths_before_setup -- --exact`:
1 test passed in 1.58 seconds. It checks the TypeScript literal fixture digest
`83766ddec51223bf5ed90edc7d85eb4e75a11eaefaf184efa7fe9e3909b5432d`
and setup digest
`8a5f024beadc50f1e19844df760cf8c329a53e3e0761028874de836b50850c40`,
as well as setup receipt, unassessed evidence, unchanged source bytes/revision,
absent host invocation, and workspace cleanup.

## Slice 2: refuse staging paths outside the overlay

Oracle — `python3 /tmp/sevro-repository-staging-refusal-oracle.py`: the actual
TypeScript CLI refused an extension declaring only `notes.txt` as an overlay
but selecting the source-only `README.md` for staging. It returned 64 with
`invalid resolved case file: fixture: invalid repository fixture staging; correct the fixture declaration`,
null run/evidence paths, and no cases. Setup, host, result allocation, and source
mutation did not occur. Capture: `unlisted-typescript/`.

Red — `cargo test --offline --locked -p sevro --test run_repository overlay::refuses_staging_a_repository_path_outside_the_declared_overlay -- --exact`:
Rust returned 0 and retained successful dry-run evidence for that invalid
selection. The test uses an empty preparation to isolate declaration refusal.

Overlay validation now checks every staged path against the declared file map,
including declarations with no overlay. It retains the existing path and file
limits and produces the existing resolved-case validation diagnostic.

Green — `cargo test --offline --locked -p sevro --test run_repository overlay::refuses_staging_a_repository_path_outside_the_declared_overlay -- --exact`:
1 test passed in 0.63 seconds; the exact public refusal, absent result/host work,
and unchanged source were verified. Concurrent schema work emitted unused-code
warnings; those unrelated files were not changed by this slice.

## Slice 3: refuse duplicate staging paths

Oracle — `python3 /tmp/sevro-repository-staging-duplicate-oracle.py`: the actual
TypeScript CLI refused a direct case with `staged: ["README.md", "README.md"]`,
returning 64 with the path-qualified invalid repository fixture staging
diagnostic. No results or host invocation appeared; source index/reference and
README bytes were unchanged. Capture: `duplicate-typescript/`. The direct-case
seam reaches this semantic guard; the extension schema already requires unique
staging array items.

Red — `cargo test --offline --locked -p sevro --test run_repository overlay::refuses_duplicate_repository_staging_paths -- --exact`:
Rust returned 0 and retained successful dry-run evidence for duplicate paths.

Overlay validation now requires case-insensitive uniqueness of staged paths,
as in the existing TypeScript declaration contract.

Green — `cargo test --offline --locked -p sevro --test run_repository overlay::refuses_duplicate_repository_staging_paths -- --exact`:
1 test passed in 0.50 seconds with the exact invocation refusal and no results
or source changes.

## Slice 4: count UTF-8 staging paths in the overlay byte limit

Oracles — `python3 /tmp/sevro-repository-staging-bound-oracle.py exact-bound`
and `python3 /tmp/sevro-repository-staging-bound-oracle.py next-byte`: actual
TypeScript invocations accepted 33,554,408 content bytes plus the 12-byte
`données.txt` file path and its 12-byte staging entry, exactly 32 MiB. Adding
one content byte returned 64 with the path-qualified repository size-limit
diagnostic before result allocation. Source bytes/index/reference remained
unchanged in both captures. The accepted fixture digest was
`9ea657ac1fa467650a1b47d466b5414db650270bdb2393be0bd0520528ec5292`.

Red — `cargo test --offline --locked -p sevro --test run_repository overlay::counts_staged_utf8_path_bytes_toward_the_repository_overlay_limit -- --exact`:
the exact-boundary control passed, but Rust also returned 0 for the next byte.

Validation now adds each staging path's UTF-8 byte length to the existing
overlay total before staging semantics are checked. The resource limit remains
32 MiB; no size policy changed.

Green — `cargo test --offline --locked -p sevro --test run_repository overlay::counts_staged_utf8_path_bytes_toward_the_repository_overlay_limit -- --exact`:
1 test passed in 5.72 seconds, covering exact acceptance, literal fixture identity,
next-byte refusal, absent host execution, and unchanged source.

## Slice 5: reject a present null staging declaration

Oracle — `python3 /tmp/sevro-repository-staging-duplicate-oracle.py null`:
the actual TypeScript direct-case CLI returned 64 with its path-qualified
`invalid repository fixture` diagnostic for `staged: null`, before results or
host work. Source index/reference and README stayed unchanged. Capture:
`null-typescript/`.

Red — `cargo test --offline --locked -p sevro --test run_repository overlay::refuses_a_present_null_repository_staging_declaration -- --exact`:
Rust treated the null optional field as absent and returned 0 with dry evidence.

The direct-case input check now rejects that present null repository field.
Generated null checks are unchanged; external extension responses continue to
fail schema validation before this private decode boundary.

Green — `cargo test --offline --locked -p sevro --test run_repository overlay::refuses_a_present_null_repository_staging_declaration -- --exact`:
1 test passed in 0.58 seconds with the literal refusal and no result/source work.

## Final scoped checks

`cargo test --offline --locked -p sevro --test run_repository --test run_extension --test run_generated --test run_dry -- --test-threads=1`
passed all 87 affected tests: 59 repository tests in 183.49 seconds, 21 extension
tests in 39.55 seconds, six generated-fixture tests in 1.66 seconds, and one dry
test in 1.07 seconds. The existing real two-minute setup deadline passed. Full
output is retained as `affected-suites.log` beside the external CLI captures.

`cargo clippy --workspace --all-targets --offline --locked -- -D warnings`
passed. Read-only `cargo fmt --all -- --check` reported no differences in these
owned Rust files after applying its ordinary formatting diff. It still reported
other owners' active test formatting; whole-candidate formatting remains the
coordinator's gate. The scoped Prettier, documentation, and diff whitespace
checks passed.

The five owned paths are held: declaration parsing, fixture handoff, repository
overlay implementation, its public test module, and this ledger. No generated
integration, hooks, executables, or committed-scaffolding behavior was added.
The local macOS runs do not establish the final published Ubuntu result.
