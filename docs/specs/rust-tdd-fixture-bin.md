# Rust fixture binary slices

This ledger records fixture binaries supplied by a real extension's generated
fixture and consumed by negotiated setup during a public dry run. The
[extension contract](../extension-protocol-v1.md),
[TypeScript binary implementation](../../src/fixtures/bin.ts),
[shared tool validator and installer](../../src/fixtures/tools.ts), and
[setup environment](../../src/fixtures/setup.ts) supply the independent behavior.
Repository binary declarations and candidate-host PATH behavior remain separate
slices. This cohort does not change direct-case preparation parsing.

## Independent oracle and command environment

The retained evidence root is
`/Users/bjro/.codex/artifacts/sevro-fixture-bin-20261016`.
`/tmp/sevro-fixture-bin-oracle.py` captured the unchanged TypeScript CLI before
the Rust test or product changes. Its `typescript/` directory retains the exact
CLI argv, extension responses, setup script, stdout, stderr, evidence, and
summary. The real extension resolves a generated repository with one fixed
commit and a declared `fixture-probe` executable. Its preparation negotiates
`sevro.fixture.setup`; the command uses `sevro run --dry --host codex` through
the existing extension-command/source and case-ID flags.

The later actual TypeScript controls were captured one at a time, before their
corresponding Rust test, with:

```sh
python3 /tmp/sevro-fixture-bin-control-oracle.py escaping-name
python3 /tmp/sevro-fixture-bin-control-oracle.py count64
python3 /tmp/sevro-fixture-bin-control-oracle.py count65
python3 /tmp/sevro-fixture-bin-control-oracle.py bytes-exact
python3 /tmp/sevro-fixture-bin-control-oracle.py bytes-next
python3 /tmp/sevro-fixture-bin-control-oracle.py directory-symlink
python3 /tmp/sevro-fixture-bin-control-oracle.py metadata-symlink
```

Each scenario has its own `controls/<scenario>/` inputs, literal command,
stdout, stderr, and summary. These scripts use owned, create-only directories;
rerunning an existing scenario is not part of this evidence.

All Cargo commands below ran through `lean-ctx` from the Rust worktree with:

```sh
export CARGO_HOME=/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain/cargo
export RUSTUP_HOME=/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain/rustup
export CARGO_TARGET_DIR=/Users/bjro/.codex/artifacts/sevro-fixture-bin-20261016/target
export PATH=/Users/bjro/.codex/artifacts/sevro-rust-feasibility-20261008/toolchain/cargo/bin:$PATH
```

## Executable installation and setup precedence

The first durable test is
`fixture_bin::installs_declared_executables_before_setup_and_prepends_their_path`
in [the public repository integration target](../../crates/sevro/tests/run_repository/fixture_bin.rs).
The declared executable contains exactly:

```sh
#!/bin/sh
printf 'fixture tool\n'
```

Setup invokes it by name despite an earlier caller PATH executable printing
`caller tool\n`. The independent receipt records the first PATH entry as
`.git/fixture-bin`, literal declared bytes, executable mode `0755`, a
`0700` directory, output `fixture tool\n`, clean Git status, committed README
bytes `fixture\n`, and HEAD `5bc31024b9c366e7f2cda7ea410571fd19acb472`.
The executable's SHA-256 is
`2ad2fa06bb6088e9525e89d0e1e7d39a5a60743205d21def017e1356ac186f32`.

The retained fixture digest is
`404bb56b18df86c7ffb876fa3c7395205e02784b6a21c93171f43c4aa3d7edbb`;
the setup digest is
`9d224ac0b1fdc2894c48dce0e3d360fbe6762e5842dcf1f0f569888d7846bcd3`.
The result and evidence agree on execution `not_run`, grading `not_requested`,
and task `not_assessed`. No native host is invoked. Successful workspace cleanup,
unchanged extension bytes, unchanged caller executable, and the original source
repository's bytes, HEAD, and clean status are asserted.

```sh
cargo test --offline --locked -p sevro --test run_repository fixture_bin::installs_declared_executables_before_setup_and_prepends_their_path -- --exact
```

- Red: the compiled test failed because the CLI returned 64 with
  `invalid case file: invalid generated fixture`, instead of the independently
  observed successful dry result. `first-red.log` retains the failure.
- Green: the identical command passed after the bounded implementation below.
  `first-green.log` retains the result: 1 passed, 64 filtered out.

Generated declarations now preserve optional `bin` for validation and identity.
Nonempty declarations install after history, overlays, and staging, before hooks
and setup. They use the existing regular-target installer and its explicit
`0755` permission update. Empty bin maps do not create a binary directory.
The shared validator preserves hook rules while adding the binary name/count
parameters. Setup prepends the validated directory to inherited PATH. The
directory is checked again after setup and artifact mounting, before host use.
Repository hooks, schema attachment, setup validation order, and fallible
filesystem errors remain intact.

## Declaration boundaries

Each following test passed on its first execution. These are initial-green
characterizations, with no product changes between controls.

```sh
cargo test --offline --locked -p sevro --test run_repository fixture_bin::refuses_escaping_executable_names_before_run_admission -- --exact
```

The declaration `../escape` returns 64 with the complete diagnostic
`invalid resolved case file: fixture: invalid fixture binaries; correct the fixture declaration`.
No results root, host invocation, or escaping file is created. The source stays
clean. Evidence: `escaping-name-initial-green.log`.

```sh
cargo test --offline --locked -p sevro --test run_repository fixture_bin::accepts_sixty_four_executables_and_refuses_the_next_at_the_protocol_boundary -- --exact
```

Sixty-four tools named `tool-000` onward are installed and observed by setup.
Their contents are `#!/bin/sh\nexit 0\n`. The fixture digest is
`a234783773490c8d46b3a1787a55e65736d67df863627a6ee66f45d99ebb0cb7`.
The 65th declaration is rejected by the extension response schema with exit 70
and `invalid extension response`, before results allocation or setup. This is
the actual public protocol boundary, not an asserted internal validator path.
Evidence: `count-bound-initial-green.log`.

```sh
cargo test --offline --locked -p sevro --test run_repository fixture_bin::bounds_executable_declarations_by_utf8_names_and_content_bytes -- --exact
```

The name `probe` plus contents `#!/bin/sh\n#` and 524,280 occurrences of `é`
occupies exactly 1 MiB of UTF-8 bytes. Setup observes 1,048,571 content bytes and
SHA-256 `64be5aa0f3e8bf0e09850ba50f145dbbe42d3630c09d55127766d9f21568480c`.
Its fixture digest is
`d44f04e4fc98724cffab85566a328a87569fcff26ad09dddf058f65b13e60f51`.
Appending one ASCII `x` returns the same exact 64 invalid-binaries diagnostic,
with no results allocation or setup receipt. Evidence:
`byte-bound-initial-green.log`.

## Setup changes and metadata containment

These two controls also passed initially without another product change.

```sh
cargo test --offline --locked -p sevro --test run_repository fixture_bin::refuses_a_setup_created_executable_directory_symlink_and_retains_the_workspace -- --exact
cargo test --offline --locked -p sevro --test run_repository fixture_bin::refuses_a_binary_directory_reached_through_redirected_git_metadata -- --exact
```

The first setup moves the installed directory into its owned project and
replaces `.git/fixture-bin` with a symlink to an owned outside directory.
TypeScript and Rust return 70 with `fixture binary directory is invalid`.
The second setup moves `.git` and replaces it with a symlink to an owned
directory containing a real `fixture-bin` directory. Both return 70 with
`fixture binary directory escapes the workspace`. Thus a real final directory
alone does not bypass canonical metadata containment.

Both tests assert the retained workspace and README, actual symlink target,
unchanged outside sentinel, preserved original executable bytes, no native
invocation, and an unchanged source. They do not manufacture internal failures
or replace safety guards. The logs are
`directory-symlink-initial-green.log` and
`metadata-symlink-initial-green.log`.

Linux retention tests reenter only the exact selected test under the established
Bubblewrap private `/var/tmp` mount and a recursion marker. macOS uses the owned
fixture TMPDIR. Cleanup cannot enumerate or remove shared reservations. Local
macOS results do not establish the nested Linux execution; CI must verify it.

## Final checks

The affected regression passed all 120 tests: 1 inline dry, 21 extension,
28 generated, and 70 repository tests, including all six bin controls and the
actual two-minute setup deadline. No tests failed, were ignored, or filtered:

```sh
cargo test --offline --locked -p sevro --test run_repository --test run_extension --test run_generated --test run_dry -- --test-threads=1
cargo clippy --workspace --all-targets --offline --locked -- -D warnings
```

Both commands passed. The retained command/output files are
`affected-regression.log` and `strict-clippy-completion.log` in the evidence
root. `cargo fmt --all -- --check` reported no differences in any owned bin
file; its only remaining difference was the independently owned
`run/records.rs` line wrapping, left to its owner. The owned formatting was
applied from rustfmt's read-only diff. `git diff --check`,
`bunx prettier --check docs/specs/rust-port.md docs/specs/rust-tdd-fixture-bin.md`,
and `bun run check:docs` passed. The existing Rust port index links this ledger
and the separately owned source-map and state-root ledgers.

Combined publication, compiler coverage, and Linux acceptance remain owned by
the coordinator. The direct-case preparation file remains unchanged at SHA-256
`bf8227466e3bc7c978a955a11d47e944563c931b08043865bd8c33d3304dcc5d`.
