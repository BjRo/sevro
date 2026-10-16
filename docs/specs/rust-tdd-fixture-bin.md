# Rust fixture binary slices

This ledger records fixture binaries supplied by generated and repository
fixtures, including a real extension and negotiated setup during a public dry run. The
[extension contract](../extension-protocol-v1.md),
[TypeScript binary implementation](../../src/fixtures/bin.ts),
[shared tool validator and installer](../../src/fixtures/tools.ts), and
[setup environment](../../src/fixtures/setup.ts) supply the independent behavior.
Candidate-host PATH behavior remains a separate slice. The initial generated
cohort left direct-case preparation parsing unchanged; the later repository
cohort records its declaration changes below.

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

## Generated cohort checks

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
the coordinator. That cohort left the direct-case preparation file unchanged at SHA-256
`bf8227466e3bc7c978a955a11d47e944563c931b08043865bd8c33d3304dcc5d`.

## Repository executable installation

The next bounded cohort starts after the Git HEAD grader was committed as
`db21006306c205cef702012ac79e5512bdae597e`. Its public authority also includes
the repository declarations and metadata-preservation rules in
[the development CLI contract](../development-cli.md) and
[the TypeScript repository fixture](../../src/fixtures/repository.ts).
The existing TypeScript test
`repository overlays preserve source, index state, and metadata boundaries`
in [repository-fixture.test.ts](../../tests/repository-fixture.test.ts) asserts
declared binaries and the candidate's fixture directory.

Independent actual CLI capture:

```sh
python3 /Users/bjro/.codex/artifacts/sevro-repository-bin-next-20261016/oracle.py
```

The evidence root is
`/Users/bjro/.codex/artifacts/sevro-repository-bin-next-20261016`.
Its `typescript/` directory retains the literal argv, extension responses,
setup script, streams, evidence, and summary. The extension resolves a
repository source with a declared `fixture-probe`. Both source Git metadata
and the inherited caller PATH contain different executable bytes. Setup observes
the declared executable and records:

- Exact output `repository tool\n` and contents
  `#!/bin/sh\nprintf 'repository tool\\n'\n`.
- First PATH entry `.git/fixture-bin`, regular nonsymlink executable mode `0755`,
  and binary directory mode `0700`.
- Detached HEAD `afe4c3288517f0e9274c733e59c1349e7c984594`, no remotes, clean
  status, and README bytes `repository fixture\n`.
- Fixture digest
  `c043be5566fcf0dabc54dc84dc27842d081f055dd6f1fd8b17a7f290ce18f78a`
  and setup digest
  `a34e09c69aeb96f8cacca6480dbfbfb5ea65a406500bdd008491b87f41456912`.

The public result is 0/not_run/not_requested/not_assessed. The original source
keeps its HEAD, `main` branch, clean status, README, and distinct `0700`
metadata executable. The caller executable and extension remain unchanged,
the native host is not invoked, and the successful workspace is removed.

- Red — `cargo test --offline --locked -p sevro --test run_repository fixture_bin::installs_repository_executables_before_setup_without_copying_source_metadata -- --exact`:
  the compiled test returned CLI 64 instead of 0, with `invalid case file:
unknown field bin` and the supported-field list. Product code was unchanged.
- Green — `cargo test --offline --locked -p sevro --test run_repository fixture_bin::installs_repository_executables_before_setup_without_copying_source_metadata -- --exact`:
  1 passed, 70 filtered out. All literal receipt, digest, preservation and
  cleanup assertions passed. Logs: `first-red.log` and `first-green.log` in
  this cohort's evidence root.

The repair carries the optional typed map through the repository declaration,
semantic validation, resolved fixture and identity. Repository installation
runs after cloning and overlay/staging, before declared hooks and setup.
Generated and repository fixtures share the existing nonempty-bin installer;
regular-target checks, explicit modes, canonical directory validation and all
shared declaration bounds remain intact. There is no host-request, native
state, result-recording, or filesystem-policy change in this cohort.

## Direct repository declaration controls

Each following TypeScript capture was made before its corresponding Rust test:

```sh
python3 /Users/bjro/.codex/artifacts/sevro-repository-bin-next-20261016/control-oracle.py null
python3 /Users/bjro/.codex/artifacts/sevro-repository-bin-next-20261016/control-oracle.py array
python3 /Users/bjro/.codex/artifacts/sevro-repository-bin-next-20261016/control-oracle.py nonstring
python3 /Users/bjro/.codex/artifacts/sevro-repository-bin-next-20261016/control-oracle.py omitted
python3 /Users/bjro/.codex/artifacts/sevro-repository-bin-next-20261016/control-oracle.py empty
python3 /Users/bjro/.codex/artifacts/sevro-repository-bin-next-20261016/control-oracle.py count64
python3 /Users/bjro/.codex/artifacts/sevro-repository-bin-next-20261016/control-oracle.py count65
```

Named `controls/<scenario>/` directories retain the exact commands, input,
streams and summary. Invalid declarations return the complete 64 pre-run
envelope, a diagnostic naming the selected case file and `invalid fixture
binaries`, no result allocation or host invocation, and unchanged caller bytes.

- Red — `cargo test --offline --locked -p sevro --test run_repository fixture_bin::refuses_null_repository_executables_before_run_admission -- --exact`:
  Rust erased explicit `bin: null` as an absent optional map and returned 0
  with retained dry evidence, instead of the actual TypeScript refusal.
- Green — `cargo test --offline --locked -p sevro --test run_repository fixture_bin::refuses_null_repository_executables_before_run_admission -- --exact`:
  1 passed, 71 filtered out after validating direct repository bin shape before
  deserialization. Logs: `null-red.log` and `null-green.log`.

The remaining three tests passed on their first runs. They are characterizations,
not additional claimed behavioral reds; no product changes followed the null fix:

- `cargo test --offline --locked -p sevro --test run_repository fixture_bin::names_malformed_repository_executable_maps_before_run_admission -- --exact`:
  array maps and nonstring contents receive the same exact named diagnostic,
  preserve input/source bytes, and allocate no result storage.
  Log: `shape-initial-green.log`.
- `cargo test --offline --locked -p sevro --test run_repository fixture_bin::distinguishes_omitted_and_empty_repository_executables_in_identity -- --exact`:
  both valid dry selections succeed and clean their workspaces. Omitted bin has
  fixture digest `c251594c3b1e6f1efd85323db61c518d9753d0fe82016b5aba7136878f4903ef`;
  explicit `{}` has
  `9db42e8d180122b62f66ef7d13880e95f484256a8f66a29c9e7cbe5b50f32af1`.
  Log: `identity-initial-green.log`.
- `cargo test --offline --locked -p sevro --test run_repository fixture_bin::bounds_direct_repository_executables_before_run_admission -- --exact`:
  64 direct-case tools succeed with fixture digest
  `c0cb8ad378ce98addfbaf4933672e1451c16c7f6aa92335f786fe7b352a654d5`;
  the 65th receives the exact 64 semantic refusal before admission. This
  complements the earlier extension schema's 70 refusal for the 65th tool.
  Log: `count-initial-green.log`.

## Repository cohort checks

The affected regression passed all 125 tests: 75 repository, 28 generated,
21 extension, and 1 inline dry. That includes all five new repository-bin
tests, the earlier generated-bin controls, and the actual two-minute setup
deadline. No tests failed, were ignored, or were filtered:

```sh
cargo test --offline --locked -p sevro --test run_repository --test run_extension --test run_generated --test run_dry -- --test-threads=1
cargo clippy --workspace --all-targets --offline --locked -- -D warnings
```

Both commands passed in the dedicated fixture-bin target. Their complete output
is retained as `affected-regression.log` and `strict-clippy-completion.log` in
the repository cohort evidence root. The three previously committed Git HEAD
controls also passed unchanged, each selected separately to avoid running the
other owner's in-progress verdict tests:

```sh
cargo test --offline --locked -p sevro --test run_git_head git_head_advance_preserves_the_base_and_passes_changed_and_ancestry -- --exact
cargo test --offline --locked -p sevro --test run_git_head git_head_rewind_changes_head_but_fails_ancestry_with_retained_evidence -- --exact
cargo test --offline --locked -p sevro --test run_git_head git_head_unchanged_passes_with_runner_owned_base -- --exact
```

Those exact commands and results are retained in `git-head-regression.log`.
The read-only `cargo fmt --all -- --check` reported no differences in owned
files; its remaining differences were in separately owned
`adapters/transport.rs` and `tests/run_git_head.rs`, left to their owners.
Owned formatting was applied from rustfmt's read-only diff.
`git diff --check`,
`bunx prettier --check docs/specs/rust-tdd-fixture-bin.md`, and
`bun run check:docs` passed.

The source and test files are held for coordinator acceptance and publication.
These are scoped results, not a claim of complete workspace or Linux acceptance.
Native candidate PATH and the programmatic fixture-input handoff remain
separately coordinated work.
