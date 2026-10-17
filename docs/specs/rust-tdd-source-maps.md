# Rust source-map input controls

The public Rust CLI rejects malformed and unreadable selected source maps with
exit 64 before native execution or results allocation. These controls passed on
their first runs; this cohort adds characterization coverage without changing
the source-map loader or claiming an implementation red.

## Contract and actual oracle

The [CLI contract](../development-cli.md) requires `--case-source-root` and
`--case-source-map-file` together. The map is a JSON object from source IDs to
`file:///` URL strings. The [result contract](../results-v1.md#exit-codes)
classifies invalid pre-run configuration as exit 64.

The independent implementation is
[`loadPreparationSources`](../../src/cli/loading.ts), whose JSON loader wraps
read/parse failures without exposing their causes. The existing
[CLI source-map controls](../../tests/cli/case-validation.test.ts) refuse null,
arrays, foreign URLs and non-string URL values before admission.

Fresh public TypeScript CLI observations were captured with:

```sh
python3 /tmp/sevro-source-map-oracle-20261016.py
```

The artifact directory contains `manifest.json`, each named observation and
`probe.py`, including literal CLI arguments, environment, streams, full result
objects and before/after caller and TypeScript source hashes:

```text
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-source-map-oracle-qajeiw45
```

Each invocation used an owned project and source root, a valid inline case,
explicit digest overrides, isolated HOME/TMPDIR and a synthetic Claude executable
that would record any invocation. Its credential file contains only a synthetic
marker. No installed native host, user credentials or model service was used.

| Selected map input                           | Actual diagnostic message                       |
| -------------------------------------------- | ----------------------------------------------- |
| Incomplete JSON containing a private marker  | `case source map file is unreadable or invalid` |
| Missing file                                 | `case source map file is unreadable or invalid` |
| Directory supplied as the map file           | `case source map file is unreadable or invalid` |
| `null` or `[]`                               | `case source map must contain file URLs`        |
| `{"reference":"https://example.com/source"}` | `case source map must contain file URLs`        |
| `{"reference":42}`                           | `case source map must contain file URLs`        |

All seven observations returned exit 64 and one JSON document with
`sevro.invocation.invalid`, `not_run` / `not_requested` / `not_assessed`, null
run/evidence identifiers and no cases. Results storage was absent, the synthetic
executable was not invoked, and caller bytes remained unchanged. Neither the
malformed input marker nor synthetic credential appeared in public streams.
All inspected TypeScript source hashes remained unchanged.

## Sequential Rust evidence

Commands used the dedicated target
`CARGO_TARGET_DIR=/tmp/sevro-rust-source-maps-20261016`.

Initial-green characterization — `cargo test -p sevro --test run_source_maps refuses_malformed_source_map_json_before_execution --locked -- --exact`:
one test passed against unchanged product code. Incomplete JSON returns the exact
read/parse diagnostic and preserves the input bytes without leaking the marker.

Initial-green characterization — `cargo test -p sevro --test run_source_maps refuses_unreadable_source_maps_before_execution --locked -- --exact`:
one test passed against unchanged product code. A nonexistent map and a real
directory selected as the file both produce the exact read/parse diagnostic.
No injected I/O errors, permission tricks or filesystem races are involved.

Initial-green characterization — `cargo test -p sevro --test run_source_maps refuses_source_maps_without_string_file_urls_before_execution --locked -- --exact`:
one test passed against unchanged product code. The four invalid forms from the
TypeScript integration test produce the exact shape/value diagnostic.

Every test asserts the complete public JSON failure envelope, the diagnostic
stderr line, absence of results and host invocation, and preservation of caller
files. These non-dry commands establish refusal before execution. They do not
call private methods or substitute artificial loader failures.

After those greens, the test helper's CLI invocation and refusal assertions were
separated to keep each helper focused. `cargo test -p sevro --test run_source_maps --locked`
then passed all three tests, with no failures, ignored tests or filtered tests.

## Boundary and checks

Only `crates/sevro/tests/run_source_maps.rs` and this ledger were added.
The current loader is `crates/sevro/src/run/fixtures/sources.rs`; it remains
unchanged. Options, manifests, preparation, fixture lifecycle, host handling,
records, Cargo, test registration and source inventories were not edited.
Existing mapped-source success and containment tests remain separate; this
cohort makes no new coverage-percentage or full-acceptance claim.

`cargo clippy -p sevro --test run_source_maps --locked -- -D warnings`,
`bun node_modules/prettier/bin/prettier.cjs --check docs/specs/rust-tdd-source-maps.md`
and `bun run check:docs` passed. After the new test's formatting was corrected,
`cargo fmt --all -- --check` reported no difference in that file. The complete
format check still failed on concurrently edited fixture-tool, records,
installed-bundle, fixture-bin and state-root files owned by other slices; none
was changed here. Frozen-candidate formatting and broad acceptance remain
coordinator-owned.
