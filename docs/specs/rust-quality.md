# Rust quality during the port

The Rust workspace must pass formatting, compilation, Clippy, real integration
tests, installed-binary execution, and compiler coverage on both supported
platforms. This contract governs the added Rust code. It supplements the
[TypeScript quality contract](../typescript-quality.md) while TypeScript
production, fixtures, adapters, examples, and tooling remain.

The [delivery parity specification](rust-delivery-parity.md) records existing
acceptance obligations. A green Rust bootstrap gate proves only the Rust
behavior currently implemented and tested; it does not prove the full migration,
npm package compatibility, native-host parity, or the retired TypeScript gate.

## Tools and commands

[`rust-toolchain.toml`](../../rust-toolchain.toml) pins Rust 1.99.0 with rustfmt,
Clippy, and `llvm-tools-preview`. [`Cargo.lock`](../../Cargo.lock) is committed;
builds, tests, lint, and installation use `--locked` so a changing dependency
resolution fails instead of changing the candidate.

Run the following from the repository root after installing rustup and the
existing [integration prerequisites](../../CONTRIBUTING.md#set-up-development):

```sh
rustup show active-toolchain
cargo fmt --all -- --check
cargo build --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
```

Keep observable behavior tests in each crate's `tests/` directory, using real
filesystem, CLI, child-process, and protocol seams. New product behavior follows
a failing test with a verified behavioral failure, then the smallest complete
implementation and relevant green checks. A scaffold, compilation failure, or
test that duplicates implementation is not a behavioral red result.

## Compiler coverage

Use the pinned `cargo-llvm-cov` 0.9.1 and Rust's LLVM component. The maintained
tool owns instrumentation, merging, and threshold calculation; Sevro adds no AST
instrumenter or replacement counter format. The upstream
[versioned usage documentation](https://github.com/taiki-e/cargo-llvm-cov/blob/v0.9.1/README.md#usage)
defines the report and threshold flags.

```sh
cargo install cargo-llvm-cov --version 0.9.1 --locked
mkdir -p .coverage
cargo llvm-cov clean --workspace
cargo llvm-cov --workspace --all-targets --locked --no-report
cargo llvm-cov report --json --ignore-filename-regex '(^|/)tests/' --output-path .coverage/coverage.json
cargo llvm-cov report --lcov --ignore-filename-regex '(^|/)tests/' --output-path .coverage/lcov.info
cargo llvm-cov report --html --ignore-filename-regex '(^|/)tests/' --output-dir .coverage/html
cargo llvm-cov report --ignore-filename-regex '(^|/)tests/' --fail-under-lines 95 --fail-under-regions 95
```

The two thresholds apply independently to LLVM line and region counts across
workspace production code. Tests stay outside the production denominator using
the explicit path filter; the tool also applies its standard dependency,
toolchain, generated-target, and test/example/benchmark filters. No authored
production source may be placed under a filtered path or given a coverage
exemption. Review the JSON file inventory as well as totals when adding modules.
Platform-specific code follows compiler target configuration; shared reachable
code must remain measured on each platform. Zero-execution production is not
made covered by importing or calling it only for measurement.

Start with a clean coverage directory through the tool's clean command. A report
must come from this candidate's tests and profiles; no previous commit or other
platform may supply missing counters. Failed tests or profile/report errors
fail the gate even if another report can be rendered. Reports are generated
before threshold enforcement so a low-coverage failure retains useful evidence.
The ordinary test command separately executes documentation tests; the stable
coverage run does not measure them.

Branch coverage is an explicit outstanding migration requirement.
`cargo-llvm-cov`'s branch option requires nightly and is unstable in the pinned
release. Line and region results therefore cannot be presented as branch
coverage or as fulfillment of the existing 95% TypeScript branch contract.
Before full port acceptance, pin and verify a supported nightly branch path,
document the compiler's branch denominator and limits, and add the corresponding
independent gate. Preserve the existing TypeScript branch gate until its complete
replacement is demonstrated. See the upstream
[branch tracking issue](https://github.com/taiki-e/cargo-llvm-cov/issues/8).

## Installed executable

Install the workspace binary into a fresh temporary prefix with
`cargo install --path crates/sevro --locked --root <absolute-prefix>`, then
invoke `<absolute-prefix>/bin/sevro --help` and `--version` from a different
temporary directory without source Git metadata. Retain the installed outputs
and executable checksum.
This establishes that the executable can start outside its checkout. The
installed npm workflows, package assets, adapters, templates, grading, reporting,
and provenance remain separate required parity checks in the
[delivery specification](rust-delivery-parity.md#installed-package-behavior).

## Continuous integration evidence

[The Rust workflow](../../.github/workflows/rust.yml) runs every PR candidate,
main push, and manual dispatch on `ubuntu-24.04` x64 and `macos-15` arm64.
These architectures follow GitHub's
[runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
It installs the existing locked Bun compatibility dependencies and pinned native
test tools; Linux prepares bubblewrap isolation, and macOS requires sandbox-exec,
ripgrep, and the C compiler. Tests execute as the runner user. Existing native
test prerequisites must not silently become skipped acceptance.

For a PR, checkout selects its exact head SHA. The artifact name identifies that
SHA, platform, and workflow attempt. Retained evidence includes the source
archive and SHA, Cargo lockfile, toolchain file and reported versions, workflow
run and attempt, platform/architecture, test logs, installed executable/checksum,
JSON counters, LCOV, HTML, coverage summary, and LLVM profiles when available.
Artifacts upload even after failure; their presence alone does not mean checks
passed. A checkout or tool-installation failure may leave only partial evidence.

Both matrix jobs must succeed for the stable `Rust quality` status. A cancelled,
skipped, failed, or missing platform cannot establish success. The coordinator
must observe the exact published head's required statuses, including the existing
TypeScript gate, and repair in-scope failures before claiming delivery. The
workflow does not publish binaries, npm packages, Git tags, or releases.
