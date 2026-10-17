# Rust CLI Codex configuration evidence

The Rust CLI imports the supported agent-concurrency integer once for a selected
Codex candidate, retains it in configuration identity and applies it to the
private native profile. Adapter and Claude routes ignore `.codex/config.toml`;
configuration-root validation still applies. Only that integer is imported.

The first cohort below established non-Codex routing while Codex import still
had its temporary refusal. The later native cohort replaces that refusal.

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

In the non-Codex cohort, only `run/identity.rs`, `tests/run_config.rs` and this
ledger changed. The product
change is a non-Codex return before the existing file inspection. Codex file
refusal, I/O diagnostics, root validation, adapter transport, native transports,
preparation, grading, provenance, publication and exit precedence are unchanged.
No dependency, schema or coverage-policy changes were made.

The native Codex import was reserved for a separate full vertical slice: capture its
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
The coordinator subsequently published that cohort in `0663a527` after the exact
frozen candidate passed formatting, strict Clippy, tests and documentation gates.

## Native configuration import

The [CLI contract](../development-cli.md#project-and-configuration-roots),
[identity contract](../identity-v1.md),
[TypeScript loader](../../src/hosts/codex-configuration.ts) and
[CLI integration tests](../../tests/cli/codex-configuration.test.ts) provide the
independent behavior. Configuration selection precedes case and host execution.
The native profile receives only `agents.max_concurrent_threads_per_session`,
as a positive TOML integer no greater than `9007199254740991`. Missing settings
retain null; floats, including `5.0`, are not integer settings.

Two fresh public TypeScript captures used owned temporary projects, synthetic
credentials and output, and the installed Codex sandbox (`codex-cli 0.163.0`).
Neither used a model service or user credentials. Commands, streams, evidence,
private profile observations, probe source and unchanged TypeScript source hashes
are retained under:

```text
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-codex-config-import-oracle-75vzh2ej
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-codex-config-controls-oracle-175bsaj6
```

The external probes are `/tmp/sevro-codex-config-import-oracle-20261016.py`
and `/tmp/sevro-codex-config-controls-oracle-20261016.py`. The first actual run
selected limit 7 from the configuration root over project limit 3. It completed
execution and grading with a passed task, input/output usage of one token each,
null cost and complete usage. It observed limit 7 in the generated private
profile and retained candidate configuration, preserved caller files and removed
the four observed private-state/workspace paths. The unrelated model setting and
synthetic credential did not appear in retained evidence or public streams.

The second capture established dry identity comparisons, exact preparation-error
messages, missing-setting defaults and filesystem boundaries. Its actual native
snapshot run deliberately changed the caller configuration from 7 to 9 during
the first synthetic invocation: the two trial profiles remained 7/7, and the
next CLI invocation selected 9. This uses deterministic caller-file mutation,
not a timing race or private-function test.

### Native sequential evidence

All commands below used
`CARGO_TARGET_DIR=/tmp/sevro-rust-codex-config-import-20261016`.

Red — `cargo test -p sevro --test run_config native_codex::imports_only_the_selected_codex_agent_limit --locked -- --exact`:
exited 101; unchanged product returned CLI 64 with the temporary configuration
loading refusal instead of the executed success observed in TypeScript.

Green — `cargo test -p sevro --test run_config native_codex::imports_only_the_selected_codex_agent_limit --locked -- --exact`:
one test passed after typed loading, retained selection and private-profile
integration. The first post-implementation attempt reached the successful run
but exposed a test assertion comparing JSON integer `1` with float `1.0`.
The assertion was corrected to compare numeric values; that representation
mismatch is not claimed as another product defect or behavioral red.

Initial-green characterization — `cargo test -p sevro --test run_config native_codex::identity_tracks_the_limit_but_not_unrelated_settings_or_configuration_location --locked -- --exact`:
one test passed. Dry 7/9/7 changes and restores configuration and evaluation
digests; relocation and unrelated setting changes preserve them.

Initial-green characterization — `cargo test -p sevro --test run_config native_codex::snapshots_the_limit_across_trials_and_reloads_on_the_next_invocation --locked -- --exact`:
one test passed with actual native profile observations 7/7/9 and matching
retained settings. No further product change was needed.

Initial-green characterization — `cargo test -p sevro --test run_config validation::malformed_toml_and_non_table_agents_are_preparation_errors --locked -- --exact`:
one test passed with exact TypeScript diagnostics, exit 64, an unassessed result,
no results allocation and no host invocation. Parser causes remain internal.

Initial-green characterization — `cargo test -p sevro --test run_config validation::requires_a_positive_safe_toml_integer --locked -- --exact`:
one test passed. Zero, negative, fractional, integral-float, string, Boolean and
`9007199254740992` values are refused; 1 and `9007199254740991` are retained exactly.

Red — `cargo test -p sevro --test run_config validation::refuses_linked_or_nonregular_configuration_files --locked -- --exact`:
exited 101 because a linked configuration file was followed and CLI returned 0
instead of 64.

Green — `cargo test -p sevro --test run_config validation::refuses_linked_or_nonregular_configuration_files --locked -- --exact`:
one test passed after inspecting original file metadata. Valid and dangling file
links and a directory in place of the file are refused without changing inputs.

Red — `cargo test -p sevro --test run_config validation::bounds_configuration_files_to_64_kib --locked -- --exact`:
exited 101 because a 65537-byte file was accepted with CLI 0 instead of 64.

Green — `cargo test -p sevro --test run_config validation::bounds_configuration_files_to_64_kib --locked -- --exact`:
one test passed after enforcing the metadata size bound. Exactly 65536 bytes
remain accepted, matching the loader contract.

Red — `cargo test -p sevro --test run_config validation::distinguishes_absent_settings_from_an_unusable_configuration_directory --locked -- --exact`:
exited 101 because a dangling `.codex` directory link silently selected defaults
and returned 0 instead of 64.

Green — `cargo test -p sevro --test run_config validation::distinguishes_absent_settings_from_an_unusable_configuration_directory --locked -- --exact`:
one test passed after distinguishing an undeclared directory from an unusable
declared directory. Absent directory/file and empty or unrelated settings retain
null; dangling links and regular files in place of `.codex` are refused.

Red — `cargo test -p sevro --test run_config validation::requires_configuration_containment_but_allows_a_contained_directory_link --locked -- --exact`:
exited 101 because a `.codex` directory link escaping the configuration root
imported limit 7 and returned 0 instead of 64.

Green — `cargo test -p sevro --test run_config validation::requires_configuration_containment_but_allows_a_contained_directory_link --locked -- --exact`:
one test passed after canonical file containment validation. A directory link
whose regular configuration file stays inside the selected root remains valid.

Before final handoff, a fresh public comparison established that TypeScript's
parser accepts integer syntax beyond signed 64-bit. The original Rust
`toml::Value` representation rejected that syntax before setting validation.
The exact commands, unchanged input contents and both runtimes' observations are
in `observation.json` under:

```text
/private/var/folders/_b/yvzxqsys46l91yf5dtlk7q9w0000gn/T/sevro-codex-config-large-integer-oracle-9ddlqez0
```

The probe is `/tmp/sevro-codex-config-large-integer-oracle-20261016.py`.
A selected value `9223372036854775808` produced TypeScript's positive-integer
diagnostic rather than the Rust syntax diagnostic; the same unrelated integer
alongside selected limit 7 produced TypeScript exit 0 versus Rust exit 64.

Red — `cargo test -p sevro --test run_config validation::classifies_a_large_integer_as_an_invalid_limit --locked -- --exact`:
exited 101 because the public message was `Invalid Codex configuration: <path>`
instead of `Expected a positive integer for agents.max_concurrent_threads_per_session in <path>`.

Green — `cargo test -p sevro --test run_config validation::classifies_a_large_integer_as_an_invalid_limit --locked -- --exact`:
one test passed after using the pinned parser's public `DeTable`/`DeInteger`
representation. Syntax remains typed and validated; only the selected integer's
normalized digits and radix undergo checked conversion and the safe-integer bound.

Initial-green characterization — `cargo test -p sevro --test run_config validation::ignores_an_unrelated_large_integer --locked -- --exact`:
one test passed. The same representation change also removes eager conversion
of unrelated integers. The separate test was added only after the selected-value
green, so no second durable red is claimed. Limit 7 is retained, the unrelated
value is omitted, and caller bytes remain unchanged.

### Native implementation boundary

The new `run/codex_configuration.rs` owns file validation and typed TOML parsing
using the existing pinned `toml` dependency. `run.rs` captures the selection
before opening the host or loading the case. `run/host.rs` retains the typed
scalar and supplies it to `native/codex.rs`; state/profile code emits a fresh
`[agents]` table. `run/identity.rs` retains the same scalar in effective settings,
while existing host-configuration hashing binds it to identity. No raw caller
TOML is copied into the private profile, and trials do not reread the file.

The tests are in `tests/run_config.rs`, `tests/run_config/native_codex.rs` and
`tests/run_config/validation.rs`. No Cargo dependency, preparation, protocol,
coverage policy, transport, temporary diagnostic label or empty-runtime policy
was changed. Secondary host roles remain outside the current Rust CLI scope.

### Native final checks

`cargo test -p sevro --test run_config --locked` passed all 13 tests after the
typed parsed-tree repair, with no failures, ignored tests or filtered tests.
The cohort contains six genuine red/green pairs and five initial-green controls,
plus the two previously published non-Codex route tests.

`cargo test -p sevro --test run_native_codex runtime:: --locked` passed the two
existing selected-empty-runtime and absent-policy controls before the final
numeric representation repair. State/profile emission did not change afterward.

The final `cargo clippy -p sevro --bin sevro --test run_config --locked -- -D warnings`,
`cargo fmt --all -- --check`,
`bun node_modules/prettier/bin/prettier.cjs --check docs/specs/rust-tdd-run-config.md`
and `bun run check:docs` passed. The early formatting check's unrelated
concurrency-test diff was resolved by its owner; no unrelated file was edited
here. Broad acceptance and publication remain coordinator-owned.
