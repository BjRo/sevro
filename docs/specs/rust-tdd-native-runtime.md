# Rust native runtime TDD evidence

This ledger records the first Codex execution slice for the already accepted
empty runtime declaration. It follows the [runtime contract](../runtime-v1.md)
and [runtime/host parity specification](rust-runtime-hosts-parity.md#rh28-role-environments-and-temporary-storage).
It does not establish full runtime-policy or native-host parity.

## Public seam and independent oracle

The public seam is `sevro run --json --host codex --runtime-config-file runtime.json`.
The selected file contains exactly `{"format":"sevro.runtime.v1"}`. The case
requires `sevro.host.runtime` and compares the actual sandboxed command output
with `uv=1;py=1`. The synthetic native peer delegates both preflight and its
candidate command to the installed Codex sandbox. It replaces model responses,
not filesystem isolation, environment application, or evidence retention.

The unchanged TypeScript CLI was executed on macOS before the Rust test was
written. Its dedicated external capture is
`/private/tmp/sevro-empty-runtime-oracle.NBGB92/`. Each selection retains exact
argv and working directory in `command.json`, separate stdout and stderr,
`evidence.json`, and `baseline-report.json`; `verification.json` records the
independent raw-byte and cleanup checks. This is local historical evidence,
not a portable repository fixture or an Ubuntu acceptance claim.

The capture uses the real `src/cli.ts` entrypoint with explicit native binary,
synthetic authentication, model and effort, and literal runner/project digest
overrides (`a` and `b`, each repeated 64 times). Ambient `UV_OFFLINE` and
`PYTHONDONTWRITEBYTECODE` are removed. The private host sentinel must not reach
the selected native peer. The authoritative implementation of this behavior is
also exercised by
[`tests/runtime/environment.test.ts`](../../tests/runtime/environment.test.ts).

The selected empty policy produced exit 0, completed execution and grading,
and a passed task. The retained raw message was exactly `uv=1;py=1`, with SHA-256
`de0a58092a1234b49f85f03fe2f88017b85af1e76fe6d734fb75461dbd9698b7`.
Its complete `sevro.host.runtime` observation has source `sevro.host.codex`,
method `runner_configuration`, role `candidate`, and policy digest
`020bd151fdaee9ab5143114da14ff91278577c0af71901ff7f35f0d5c765036c`.
Declared environment names, read roots, seeds, discovery and skipped roots are
all empty. Runner-supplied environment defaults are not caller declarations.

The absent-policy comparison produced `uv=;py=`, no runtime observation, exit 4,
completed execution, unavailable grading and a failed task: the exact-output
check fails while the required evidence is missing. Its retained raw SHA-256 is
`c30740aa61aa22015678ff3c0f12c4ac920f39bd48a157e4b1c6e594ba3cb483`.

Both baseline runs wrote and read actual files in private command HOME/TMPDIR,
denied reads of source authentication and native authentication/configuration,
and removed all observed native and command-private paths. TMPPREFIX pointed
inside private TMPDIR. The passing workspace was removed; the failed control's
workspace was retained. Synthetic source authentication bytes were unchanged.

## Selected-policy red and green

The durable integration test is
[`runtime::applies_selected_empty_runtime_and_retains_evidence`](../../crates/sevro/tests/native_codex/runtime.rs).
It checks the literal independent output/hash, normalized policy, exact runtime
observation, required-evidence result and actual private-path cleanup through
the public CLI. The existing native fixture's diagnostic hooks remain intact.

All Cargo commands below use the pinned toolchain and the dedicated
`CARGO_TARGET_DIR=/tmp/sevro-rust-native-runtime-target`.

Red — `cargo test -p sevro --test run_native_codex --locked runtime::applies_selected_empty_runtime_and_retains_evidence -- --exact`:
the unchanged Rust product compiled, then returned exit 4 instead of 0, with
completed execution, unavailable grading and a failed exact-output check.
No native diagnostic-stage failure caused this result.

Green — `cargo test -p sevro --test run_native_codex --locked runtime::applies_selected_empty_runtime_and_retains_evidence -- --exact`:
1 test passed after the selected snapshot reached Codex preparation. The host
creates private runtime HOME/TMPDIR, applies the offline/Python defaults to both
native and command environments, and emits runtime evidence from that applied
snapshot. The digest is computed from the real normalized policy; existing
record persistence assigns the source and satisfies complete required evidence.

## Absent-policy characterization

Initial green — `cargo test -p sevro --test run_native_codex --locked runtime::absent_policy_keeps_defaults_and_runtime_evidence_unavailable -- --exact`:
1 test passed on its first execution. It preserves the independent baseline's
exit 4, failed check, unavailable evidence, literal raw bytes/hash, absent policy
and runtime observation, private cleanup, and retained failed workspace. No
additional product change was made for this control.

## Validation and limits

The two focused commands above passed. The affected regression command
`cargo test -p sevro --test run_native_codex --test run_native_claude --test run_required_evidence --test run_options --test run_dry --locked`
passed 106 tests: 48 Codex, 16 Claude, 36 options, five required-evidence and one
dry preparation test.

`cargo fmt --all -- --check` reported no differences in this slice's files. Its
workspace exit was still nonzero because other active fixture, grader and
ownership edits required formatting; those files were not changed by this slice.
The scoped strict command
`cargo clippy -p sevro --lib --bin sevro --test run_native_codex --test run_native_claude --test run_required_evidence --test run_options --test run_dry --locked -- -D warnings`
initially stopped on the concurrent schema-grader integration's unused
`PreparedSchema` and `prepare_schema`. After that owner removed its unfinished
product wiring, the identical scoped Clippy command passed. No lint suppression
or grader edit was made by this slice.

`bun node_modules/prettier/bin/prettier.cjs --check docs/specs/rust-tdd-native-runtime.md`
and `bun run check:docs` passed. The global formatting differences above remain
the respective owners' responsibility before the frozen-candidate gate.

Nonempty runtime declarations remain refused by the unchanged loader. This
slice does not add environment grants, seeds, hooks, discovery, network access,
Claude runtime application, adapter policy forwarding, or runtime capability
advertisement for extension negotiation. The baseline's other native
observations are outside this slice. Existing source/private-state denial,
cancellation, timeout and native diagnostic behavior remain part of the
affected regression gate. Hosted macOS and Ubuntu acceptance remains separate.
