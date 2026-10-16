# Rust preparation artifact boundary evidence

This finite follow-up exercises the public `sevro run` command with real
extension subprocesses. The [extension contract](../extension-protocol-v1.md),
[wire schema](../../schemas/extension-v1.schema.json) and
[fixture parity specification](rust-fixtures-graders-parity.md) define the
boundary. This ledger does not establish complete preparation parity.

Independent TypeScript CLI probes were captured outside the checkout under
`/Users/bjro/.codex/artifacts/sevro-rust-artifact-boundaries-20261016` before
adding each corresponding Rust regression. Their commands, declarations and
literal result/evidence documents establish the oracles. Tests invoke the
compiled Rust binary; they do not import artifact implementation helpers.

## Duplicate identity with distinct content

Two artifacts use ID `same-id` but different paths, independently verified
SHA-256 digests and bytes (`first\n` and `second\n`). The TypeScript baseline
refuses with exit 64 and `preparation artifact IDs must be unique and nonempty`.

Initial green — `cargo test -p sevro --test run_repository artifacts::rejects_reused_artifact_ids_with_distinct_verified_payloads -- --exact`:
passed on the unchanged product. The public result contains no evidence path or
cases; the host never runs and source Git state remains clean. This is honest
characterization, not a claimed missing-behavior red/green slice.

## Git exclusion on inline fixtures

Independent baseline probes establish exit 64 for a Git-excluded artifact on
an inline fixture. Newline and DEL characters in an excluded path refuse first
with `Git-excluded artifact path contains control characters`. An explicitly
false exclusion/executable pair is accepted and normalized out of retained
references and fixture identity. Its ordinary artifact remains mode `0600`.

Initial green — `cargo test -p sevro --test run_repository artifacts::validates_git_exclusion_for_inline_fixture_artifacts -- --exact`:
all four controls passed without product changes. The accepted control retains
the literal bytes `first\n` and independently captured fixture digest
`cbc0c4d89d19a067e49317e0325bda7c587c828fdb20e428f841483c5c43dea3`.
The existing real adapter test
`executes_a_git_excluded_artifact_without_hiding_candidate_changes` supplies the
positive Git fixture case, including escaped pattern characters and visible
candidate-created files; this follow-up does not duplicate that test.

## Prefix and materialized-path collisions

The baseline refuses artifact paths `generated` and `generated/nested.txt` in
either declaration order with exit 64 and `fixture paths collide`. Traversal
through the existing committed file `README.md/nested.txt` reaches mounting and
refuses with exit 70 and `preparation artifact traverses a non-directory`.

Initial green — `cargo test -p sevro --test run_repository artifacts::rejects_artifact_prefix_collisions_and_tracked_file_traversal -- --exact`:
all three controls passed without product changes. Source bytes and clean Git
state remain unchanged, the host does not start, and no run evidence is claimed.

## Canonical base64 padding bits

The baseline refuses `Zh==` with exit 64 and
`preparation artifact content is not canonical base64`. Its alphabet and padding
length are syntactically plausible, but nonzero unused bits make it a
noncanonical representation of byte `f`; the canonical spelling is `Zg==`.

Initial green — `cargo test -p sevro --test run_repository artifacts::rejects_nonzero_base64_padding_bits_before_artifact_mounting -- --exact`:
passed without product changes. This distinct control complements the existing
missing-padding regression and does not depend on a schema-rejected value:
`contentEncoding` is descriptive, while the runtime decoder enforces canonical
encoding.

## Validated invariants and retained limits

After the controls passed, two redundant checks were removed without changing
accepted input or public diagnostics:

- The wire schema's artifact ID references `$defs/id`, which requires a
  nonempty string. The only nonempty declaration input comes from the validated
  extension response through the preparation context; direct-case runs pass an
  empty artifact list. The cross-declaration duplicate-ID check remains.
- The pinned `data-encoding` 2.11.1 `BASE64` decoder rejects noncanonical
  padding and nonzero trailing bits. Its documented canonicality property says
  decoding then encoding returns the original input. Consequently comparing
  the re-encoded value cannot fail after successful strict decoding. The decoder
  and its public error remain unchanged.

Post-refactor green — `cargo test -p sevro --test run_repository artifacts::rejects_nonzero_base64_padding_bits_before_artifact_mounting -- --exact`:
passed.

Post-refactor green — `cargo test -p sevro --test run_repository artifacts::rejects_reused_artifact_ids_with_distinct_verified_payloads -- --exact`:
passed.

The 8 MiB decoded-artifact and 32 MiB aggregate limits remain real defenses.
They cannot be crossed by inline artifacts in one response capped at 8 MiB:
base64 expansion alone restricts decoded bytes below 6 MiB before JSON overhead.
No private-counter or oversized-wire fixture is claimed to test those deeper
limits. Source-reference resolution remained outside that checkpoint; the TypeScript
pipeline resolves declared references before inline validation, so this ledger
does not describe that feature as inherently unsupported.

## Artifact boundary checkpoint

All four new cases passed on their first run. Product edits were limited to the
two proven invariant refactorings above; there is no missing-behavior red claim.

- `cargo test -p sevro --test run_repository artifacts:: --locked`: 5 passed,
  including the existing executed Git-exclusion control.
- `cargo test -p sevro --test run_repository boundaries::refuses_invalid_or_colliding_artifacts_without_modifying_the_source --locked -- --exact`:
  passed, retaining the earlier digest, missing-padding, collision and metadata
  path refusal controls.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed.
- `rustfmt --edition 2024 --check crates/sevro/src/run/fixtures/artifacts.rs crates/sevro/tests/run_repository/artifacts.rs`:
  passed.
- `bun run check:docs`: passed; this ledger was formatted with Prettier.

This finite boundary was held for the coordinator's frozen-candidate checks and
independent review before authorization of the following slice. No coverage
thresholds or exclusions changed.

## Declared source artifact dry run

A fresh independent TypeScript public CLI invocation under the external
`declared-source` fixture returned exit 0 before the Rust test was written. A
source map binds `input-data` to a file strictly inside the declared source root,
containing exactly `prepared data\n`. The real extension returns this artifact
from `prepare`, with no inline content:

```json
{
  "id": "generated-file",
  "relativePath": "generated/data.txt",
  "sha256": "738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f",
  "sourceRef": "input-data"
}
```

The neutral inline fixture contains `README.txt` with `fixture only\n`. The
baseline's fixture digest is
`474fdf0f1a03f43b3e2fc85158bd7dc3b3a99636d8d5226ecf92b227cbbcbc75`.
Retained evidence reports dry states and the same artifact bytes/digest, while
the source file remains unchanged.

Red — `cargo test -p sevro --test run_repository artifacts::retains_a_declared_source_artifact_with_verified_bytes -- --exact`:
the compiled Rust CLI returned exit 64 with
`preparation source references are not yet implemented in Rust`, rather than
the independently observed successful dry result.

Green — `cargo test -p sevro --test run_repository artifacts::retains_a_declared_source_artifact_with_verified_bytes -- --exact`:
passed after forwarding the existing parsed source configuration to artifact
preparation and resolving references before inline validation. The regression
asserts exact retained bytes/digest and fixture identity, mode `0600`, unchanged
source bytes, no candidate invocation and workspace cleanup.

The source-map loader remains unchanged and validates every map value before
artifact resolution. The resolver canonicalizes the root and referenced path,
requires a strict descendant, checks metadata size before reading, bounds the
read at 8 MiB plus one byte, and rechecks actual source and aggregate size. The
existing inline pipeline then verifies combined byte limits, content digest,
IDs, paths and flags. These are necessary defenses in this resolver; this first
success test does not establish their negative-case coverage.

The only fixture integration change passes the already-read `Sources` value to
`artifacts::prepare`. Source loading, fixture lifecycle and host protection
remain unchanged. Inspection confirmed that the existing native host context
includes the declared case-source root and map file in protected roots; this dry
test does not execute or claim validation of native sandbox behavior.

## Declared source slice checks and hold

- `cargo test -p sevro --test run_repository artifacts:: --locked`: all 6 tests
  passed, including the newly observed source-reference red/green slice.
- `cargo test -p sevro --test run_repository boundaries::validates_the_entire_source_map_as_file_urls --locked -- --exact`:
  passed, preserving validation of unused map values as well as selected ones.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/src/run/fixtures/artifacts.rs crates/sevro/src/run/fixtures.rs crates/sevro/tests/run_repository/artifacts.rs`:
  passed.
- `bun run check:docs`: passed; the ledger was formatted with Prettier.

This single slice was held for selection of the next source bounds or containment
case. Source files make decoded limits reachable without an oversized extension
response; those negative cases are not claimed as covered by this success test.

## Canonical source containment

The next authorized finite set starts with four independent public TypeScript
probes, retained under `source-containment-*` in the external evidence directory.
A relative symlink to a file inside the root is accepted with the same bytes,
artifact digest and fixture digest as the original direct source. The source
root itself, a real outside file and a symlink escaping to that file each
return exit 64 with `preparation source escapes its declared root`, no evidence
path and no cases. All original files remain unchanged and the host never runs.

Initial green — `cargo test -p sevro --test run_repository artifacts::sources::requires_canonical_source_paths_to_be_strict_descendants -- --exact`:
all four controls passed on the unchanged product. This characterizes canonical
strict-descendant containment, including the accepted internal alias; it does
not claim a missing-behavior red.

## Individual size oracle conflict

The actual TypeScript CLI under Bun 1.3.13 rejected a source containing exactly
8 MiB of byte `a` with exit 64 and
`preparation artifact content is not canonical base64`. Its generated base64
has 11,184,812 characters, round-trips exactly, but the regular expression in
`canonicalBase64Bytes` returns false at that size. The 8 MiB plus one-byte
probe returned the expected `preparation artifacts exceed the size limit`.
The independent public evidence and small runtime diagnostic are retained under
`source-size-8388608` and `source-size-8388609` outside the checkout.

This conflicts with the source-derived inclusive bound already captured in the
accepted parity specification. The exact individual-boundary regression was
left pending the maintainer's choice of declared-limit acceptance or legacy
runtime rejection. No TypeScript success baseline is claimed for it, and no
runtime-specific regex failure has been reproduced in Rust. The later approved
resolution is recorded below.

## Combined decoded size

Independent TypeScript probes under `source-aggregate-*` establish acceptance
at exactly 32 MiB and refusal at the next byte for both source-only and mixed
inline/source declarations. The source-only case references the same 1 MiB
file 32 times with distinct artifact IDs and paths; the limit counts retained
artifacts, not unique source files. The mixed case uses one inline byte, 31
one-MiB sources and a final source one byte shorter. Its next-byte control grows
only the inline payload, so it exercises the combined decoded-byte limit after
source resolution. The source-only next-byte control adds one source byte.

Initial green — `cargo test -p sevro --test run_repository artifacts::sources::bounds_combined_source_and_inline_artifacts_at_thirty_two_mib -- --exact`:
all four controls passed on the unchanged product. Success assertions compare
all retained bytes and literal digests, plus independently captured fixture
digests. Refusals require exit 64 with the exact size diagnostic and no evidence
path or cases. All source files remain unchanged, and no native host runs.

## Unreadable source roots and entries

Independent TypeScript public probes under `source-read-*` establish exit 64
with `preparation source root is unreadable` for an absent source root and
`preparation source is unreadable` for a missing selected file or a real
directory strictly inside the root. The absent-root fixture moves the complete
source tree before invocation; it does not manufacture a metadata/read race.
No special device, permission assumption or hanging stream is used.

Initial green — `cargo test -p sevro --test run_repository artifacts::sources::refuses_unreadable_source_roots_files_and_directories -- --exact`:
all three controls passed on the unchanged product. Exact public failure
documents require no evidence path or cases; original source bytes remain
unchanged and no native host runs.

An additional read-only TypeScript probe with an encoded slash in the file URL
was refused earlier during host protection with
`File URL path must not include encoded / characters`. It is outside this
artifact resolver follow-up and has no Rust parity claim here. The coordinator
received that separate boundary observation.

## Finite source boundary checks and hold

The three new public regressions above passed on their first run, with no
product changes in this follow-up. The exact individual 8 MiB case remained
pending the documented oracle decision at this checkpoint; the aggregate and
read controls did not resolve that conflict or claim coverage of post-metadata
mutation races.

- `cargo test -p sevro --test run_repository artifacts:: --locked`: all 9 tests
  passed.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/src/run/fixtures/artifacts.rs crates/sevro/tests/run_repository/artifacts.rs crates/sevro/tests/run_repository/artifacts/sources.rs`:
  passed.
- `bun run check:docs`: passed; the ledger was formatted with Prettier.

Artifact-owned files were held. The fixture lifecycle hook was released to its
setup owner; this follow-up did not change source-map loading, host protection,
artifact defenses or coverage thresholds.

## Approved individual source size

The user's exact response was: "if we don't need that limit, feel free to ignore
it". Within that discretion, the coordinator chose to omit the accidental Bun
regular-expression restriction while retaining the existing specification's
inclusive 8 MiB per-artifact and 32 MiB aggregate bounds to bound source reads
and retained evidence. The user did not dictate new numeric limits. Canonical
bytes at exactly 8 MiB are accepted; the next byte is refused. This approved
contract is the success oracle, not a claimed TypeScript success. The actual
legacy rejection and original evidence above remain valid.

Initial green — `cargo test -p sevro --test run_repository artifacts::sources::accepts_eight_mib_source_artifacts_and_refuses_the_next_byte -- --exact`:
both controls passed on the unchanged product. The accepted source consists of
8,388,608 literal `a` bytes with independently captured SHA-256
`ad97f87076920684e2ca66fc44e5d322797dc9d64706b174e51b5d0828937043`.
The test compares every retained byte, the literal digest and dry result states.
The 8,388,609-byte control requires exit 64 and
`preparation artifacts exceed the size limit`, with no evidence path or cases.
Both preserve the complete source bytes and never invoke the native host.
No product code changed, and no missing-behavior red is claimed.

## Approved size checks and hold

- `cargo test -p sevro --test run_repository artifacts:: --locked`: all 10
  artifact tests passed, including the approved individual boundary and prior
  aggregate, containment and read controls.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/tests/run_repository/artifacts/sources.rs`:
  passed.
- `bun run check:docs`: passed; the ledger and parity clarification were
  formatted with Prettier.

The approved individual-size slice is held for the coordinator's next frozen
checkpoint. No broader size policy, production code, ownership hook or coverage
threshold changed.

## Missing source configuration

The independent TypeScript public probe `checkpoint6-source-context-absent`
returns exit 64 with `preparation source root is required and must be absolute`
when a real extension declares a source artifact but the caller supplies neither
source-root nor source-map option. It retains no evidence and never invokes the
native host. The declared input file remains unchanged.

Initial green — `cargo test -p sevro --test run_repository artifacts::sources::requires_source_configuration_before_resolving_artifacts -- --exact`:
the exact public failure document and source preservation assertions passed on
the unchanged product. No product repair or missing-behavior red is claimed.

## Undeclared source reference

The independent TypeScript probe `checkpoint6-source-key-undeclared` supplies a
valid source configuration whose map contains only `other-data`, while the
extension requests `input-data`. The CLI returns exit 64 with
`preparation source reference is not declared`, no evidence and no host call.
The mapped source bytes remain exactly `prepared data\n`.

Initial green — `cargo test -p sevro --test run_repository artifacts::sources::refuses_undeclared_source_references_before_retaining_artifacts -- --exact`:
the exact failure document, unchanged source and no-host assertions passed on
the unchanged product. This separately characterizes key authorization after
valid configuration loading; it is not a missing-behavior red/green claim.

## Source authorization checkpoint

The two artifact controls and the paired
[extension source-removal control](rust-tdd-extension.md#declared-source-removed-during-discovery)
were added sequentially and each passed on its first execution. No production
code, transport behavior or ownership hook changed.

- `cargo test -p sevro --test run_repository artifacts:: --locked`: 12 passed.
- `cargo test -p sevro --test run_extension --locked`: 21 passed, including the
  real deadline and cancellation controls.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed on
  rerun. The first final-gate run encountered a concurrent single-element loop
  in the options owner's test; that owner completed its next test row before
  the rerun. This unrelated lint result was not behavioral red evidence.
- `rustfmt --edition 2024 --config skip_children=true --check crates/sevro/tests/run_extension.rs crates/sevro/tests/run_repository/artifacts/sources.rs`:
  passed.
- `bun run check:docs`: passed; both evidence ledgers were formatted with
  Prettier.

The three-case cohort is held for the next coordinator checkpoint. Filesystem
failure guards, post-read size checks and pre-spawn cancellation remain intact;
no private race test or coverage exemption was introduced.
