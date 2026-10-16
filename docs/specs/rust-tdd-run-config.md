# Rust non-Codex configuration route evidence

The Rust CLI now ignores `.codex/config.toml` when the selected candidate is
an adapter or Claude. Configuration-root validation still applies. The Codex
route retains its existing temporary refusal until a later slice implements
typed concurrency import, native profile application and retained identity.
This is not evidence that Codex configuration loading is complete.

## Contract and independent oracle

[`selectedConcurrency`](../../src/cli/hosts.ts) reads Codex configuration only
when a candidate, semantic or advisory Codex role is selected. The current Rust
candidate routes are adapter, Claude and Codex; secondary roles are outside this
slice. The [CLI contract](../development-cli.md#project-and-configuration-roots)
imports only the supported Codex agent limit. This is separate from adapter
module loading and its redacted `configuration` object, which the
[identity contract](../identity-v1.md) retains by role.

Fresh public TypeScript CLI observations were captured before each Rust test was
added. Both used an owned configuration root containing exactly:

```text
[agents
PRIVATE_UNRELATED_CONFIG_MARKER
```

The project case requests `Return ready.`, contains one inline README and one
`sevro.output` check expecting `ready`, and requires no evidence. The adapter
returns `ready`, records one invocation and declares the redacted setting
`{"example.setting":"kept"}`. The Claude control is dry and uses an owned native
invocation marker and synthetic credential file. Both use an isolated HOME and
temporary directory, explicit digest overrides and separate results storage.

The exact commands, environment, streams, retained evidence and before/after
TypeScript source hashes are in `adapter.json`, `claude-dry.json`, their evidence
files, `manifest.json` and `probe.py` under:

```text
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-non-codex-config-baseline-t_y3wkmn
```

The external probe is `/tmp/sevro-non-codex-config-baseline-20261016.py`.
All five source hashes remained unchanged across each invocation.

| Selection         | Actual exit and result                               | Retained candidate configuration       |
| ----------------- | ---------------------------------------------------- | -------------------------------------- |
| Adapter execution | 0; completed execution and grading; passed task      | `{"example.setting":"kept"}`           |
| Claude dry        | 0; not run; grading not requested; task not assessed | Canonical `sevro.host.executable` only |

Both retain `agentConcurrencyLimit: null` and the selected `configRoot`, leave
the malformed configuration bytes unchanged, and omit its private marker from
stdout, stderr and evidence. The Claude command never calls the native fixture.

## Sequential public evidence

All Rust commands used the dedicated target directory
`CARGO_TARGET_DIR=/tmp/sevro-rust-run-config-20261016`.

Red — `cargo test -p sevro --test run_config ignores_codex_configuration_on_an_adapter_route --locked -- --exact`:
exited 101 with the new public test and unchanged product code. The CLI returned
64 and `configuration loading is not yet implemented in Rust: <config-path>`
instead of executing the adapter and returning 0.

Green — `cargo test -p sevro --test run_config ignores_codex_configuration_on_an_adapter_route --locked -- --exact`:
one test passed after restricting `refuse_pending_configuration` to a selected
Codex candidate. The adapter executes once, the output check passes, and the
retained adapter configuration agrees with the TypeScript oracle.

Only after that green, the Claude dry observation was captured and its separate
test was added.

Initial-green characterization — `cargo test -p sevro --test run_config ignores_codex_configuration_on_a_claude_dry_route --locked -- --exact`:
one test passed without another product change. The CLI retains the dry result,
Claude executable and null Codex limit; no native invocation occurs. No second
behavior red is claimed.

`cargo test -p sevro --test run_config --locked` passed both tests with no
failures, ignored tests or filtered tests. Each test checks one JSON result,
its retained evidence, exact execution/grading/task states, selected configuration
root, host configuration and preservation of the unselected configuration file.
The dry control also checks unchanged synthetic credentials and no private
Claude home. These tests call the installed-style CLI entry point and do not
call private Rust functions.

## Scope and verification limits

Only `run/identity.rs`, `tests/run_config.rs` and this ledger changed. The product
change is a non-Codex return before the existing file inspection. Codex file
refusal, I/O diagnostics, root validation, adapter transport, native transports,
preparation, grading, provenance, publication and exit precedence are unchanged.
No dependency, schema or coverage-policy changes were made.

The native Codex import remains a separate full vertical slice: capture its
supported integer once, retain it in effective settings and identity, and apply
it to the generated private native profile. Ignoring a file for an unrelated
route does not authorize importing the file wholesale or forwarding its model,
credentials, environment or permission settings.

Scoped `cargo clippy -p sevro --bin sevro --test run_config --locked -- -D warnings`
and `bun node_modules/prettier/bin/prettier.cjs --check docs/specs/rust-tdd-run-config.md`
passed. The shared-worktree `bun run check:docs` attempt failed on an unrelated
missing `fixture-preparation` anchor in the concurrently edited generated-fixture
ledger. That file was not changed here, and the failure is not behavior-red
evidence. Formatter verification and documentation acceptance on the exact
publication candidate remain coordinator-owned; an earlier direct formatter
invocation was blocked by the tool's command allowlist and was not retried.
