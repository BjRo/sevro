# Rust native dry-run preparation

This increment adds the first real Rust evaluation path at the public CLI seam.
It covers `sevro run --json --dry` for a direct inline case, an explicitly
selected Codex route, and supplied runner and project SHA-256 digests. It is an
implementation slice of the [CLI and engine parity specification](rust-cli-engine-parity.md),
not full runtime parity.

## Accepted example and independent oracle

The integration test is
[`prepares_inline_native_dry_run`](../../crates/sevro/tests/run_dry.rs). It invokes
the compiled Rust executable from a private temporary project containing:

- Case `dry-example`, prompt `Return ready.`.
- Inline `README.md` containing `prepared fixture\n` and `nested/input.txt`
  containing `original input`.
- Check `answer`, grader `sevro.output`, configuration `{"expectExact":"ready"}`.
- Required evidence `example.receipt`.
- A native executable that writes an invocation marker and exits 98 if called.
- A credential file containing a recognizable private sentinel.

The route explicitly chooses Codex, model `synthetic`, and effort `low`. Runner
and project digest overrides contain 64 `a` and 64 `b` characters respectively.
These are operator-supplied identity inputs, not invented provenance. The
project is physically inspected and has no enclosing Git repository.

The unchanged TypeScript CLI executed this fixture successfully before the Rust
behavioral red. Its retained evidence confirmed the field shapes and these
literal component hashes, also independently computed from the contract's
canonical JSON inputs:

| Dimension              | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| caseDigest             | `d220f185d67b31f211f447d1256e3bfd963136a7665066cf4452dc9952429668` |
| fixtureDigest          | `03588770762134a5aaaa619ccdfb785e9fdb71be020bdc651eff8ddbf3a14d00` |
| checksDigest           | `fbdd95b077bfbcfb98b04346b5f38364a31d0f99fac56ceefb68b6257f72f242` |
| requiredEvidenceDigest | `161c1e21ac93ec931b698c87e715a0186b1a5802b84a294fbd35b61c3a883d1e` |
| evaluatorDigest        | `83e25fab2f2b5e428797aca26fd748d7a668565097e8d5ebfc83ec11c923dafc` |
| graderDigest           | `14c7c54696ae32d30b27de6a73390d05e32fdbec3f205517cceddcb907bde5d8` |
| instrumentationDigest  | `5e40c8352580659036b6fcb1cd6ef506c2c09d7a673a75a50914e53efa43f45a` |
| routeDigest            | `6b9d7cd6551a077909838fb7c000e6f4a42dde97babc608e8c2f348a57bda6e4` |

Assertions retain these literal values rather than calling the production
canonicalizer. Configuration includes the actual resolved executable path, so
its digest and the final identity vary with the temporary directory. The Rust
implementation hashes the real redacted configuration, then hashes the complete
dimension record with the `sevro.identity.v1` domain separator using RFC 8785
serialization. Further public canonicalization vectors remain required.

## Observed red and green

The first test was added while the Rust dispatcher and product behavior were
unchanged. It compiled and reached the public binary.

- Red — `cargo test -p sevro --test run_dry --locked prepares_inline_native_dry_run -- --exact`:
  failed with actual exit code 64 versus required 0. Stderr reported
  `sevro: expected the run command`.
- Green — `cargo test -p sevro --test run_dry --locked prepares_inline_native_dry_run -- --exact`:
  passed, one test, after the implementation and dispatcher wiring.

The same command initially exposed an integer-versus-floating JSON representation
difference for threshold 1 during implementation. The option now preserves the
reference JSON representation; the oracle was not weakened.

The local commands ran under the pinned Rust 1.99.0 toolchain. Formatting and
`cargo clippy --workspace --all-targets --locked -- -D warnings` passed at this
first green boundary. Combined tests and coverage belong to the coordinated
candidate gate; this document does not claim they were run for this slice yet.

## Retained behavior

Preparation creates an actual private workspace and writes the inline bytes.
The native executable and graders are not called, and credential contents are
not opened. Each trial is retained before successful fixture cleanup. The
workspace namespace follows the supported platform boundary: `/var/tmp` on
Ubuntu and the temporary directory on macOS, under `sevro-workspaces-private`.

The CLI returns exit 0 and separate `not_run`, `not_requested`, and
`not_assessed` states. It writes trial evidence, `run.json`, `result.json`, and
the results-root `latest.json` snapshot. The real run UUID and absolute paths
connect these records. Run evidence and the result are validated against the
embedded existing schemas before final retention. JSON writes use exclusive
private temporary files and atomic rename; new directories use mode 0700 and
files mode 0600.

Dry evidence reports unknown actual condition, unavailable candidate observation,
null duration and usage, an empty artifact list, and no raw candidate result.
Those absent results reflect skipped execution. The workspace observation names
the actual materialized workspace. The stored trial and final summaries match.
The test also verifies that credential contents are absent from retained evidence
and that the executable's invocation marker does not exist.

The implementation preserves the initial defaults: passive condition, one trial,
three jobs, threshold one, current-directory project/config roots, and
`.sevro/results`. It recognizes explicit scalar options for those values and
paths; unknown or unimplemented options fail instead of being silently ignored.

## Boundaries and remaining work

The entrypoint in `run.rs` coordinates typed options, typed case preparation,
identity, and retained results. The initial modules separated these responsibilities:

- `run/options.rs`: CLI decoding and canonical path resolution.
- `run/preparation.rs`: direct case declarations and supported check preparation.
- `run/identity.rs`: identity dimensions, resolved settings, and provenance.
- `run/storage.rs`: private filesystem operations and inline materialization.
- `run/records.rs`: trial/run assembly, schema validation, and snapshots.

At its first green boundary, this increment explicitly rejected execution, Claude selection, adapters,
extensions, repository/generated fixtures, runtime-policy loading, Codex config
loading, Git project provenance, unsupported grader/configuration declarations,
run-state overrides, and absent digest overrides. The supported check preparation
is currently `sevro.output` with an optional string `expectExact`. Full validation
of required-evidence identifiers, portable fixture collisions, further output
checks, text rendering, and canonicalization cases still needs coverage and
implementation.

There are no invented owner claims, leases, checkpoints, or recovery records.
SQLite ownership, concurrent admission, cancellation, crash recovery, retained
workspace ownership/expiry, and cleanup failures remain required lifecycle work.
Current successful dry fixtures are removed after trial retention; a persistence
failure can leave its actual workspace for later lifecycle recovery work. The
`runStateRoot` setting records the default location, but does not claim that an
ownership database is implemented there.

Subsequent public slices extend this initial boundary: [options and runtime
configuration](rust-tdd-run-options.md), [fixtures](rust-tdd-fixtures.md),
[extensions](rust-tdd-extension.md), [adapter execution](rust-tdd-adapters.md),
[provenance](rust-tdd-provenance.md), and [native execution](rust-tdd-native-hosts.md).
Their ledgers record the separate behavior failures and resulting implementations.
The direct native dry path still invokes neither Bun nor a TypeScript runner.
The full [Rust port specification](rust-port.md) remains the acceptance scope,
including both macOS and Ubuntu and all retained TypeScript behavior.
