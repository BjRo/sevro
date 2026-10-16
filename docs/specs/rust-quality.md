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
cargo build -p sevro --features native-bundle --test installed_bundle --locked
cargo clippy -p sevro --features native-bundle --test installed_bundle --locked -- -D warnings
cargo test -p sevro --features native-bundle --test installed_bundle --locked
cargo test --workspace --doc --locked
```

Keep observable behavior tests in each crate's `tests/` directory, using real
filesystem, CLI, child-process, and protocol seams. New product behavior follows
a failing test with a verified behavioral failure, then the smallest complete
implementation and relevant green checks. A scaffold, compilation failure, or
test that duplicates implementation is not a behavioral red result.

## Compiler coverage

Use the pinned `cargo-llvm-cov` 0.9.1 and Rust's LLVM component. The maintained
tool owns instrumentation, merging, and line/region threshold calculation;
Sevro adds no AST instrumenter or replacement counter format. The upstream
[versioned usage documentation](https://github.com/taiki-e/cargo-llvm-cov/blob/v0.9.1/README.md#usage)
defines the report and threshold flags.

```sh
cargo install cargo-llvm-cov --version 0.9.1 --locked
mkdir -p .coverage
python3 scripts/rust/test-feature-coverage.py --toolchain 1.99.0 --output-dir .coverage/feature-controls
python3 scripts/rust/coverage-profiles.py --output-dir .coverage/profiles --target-dir target/llvm-cov-profiles
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

The collector requires new output and target directories, then runs the tool's
clean command. A report
must come from this candidate's tests and profiles; no previous commit or other
platform may supply missing counters. Failed tests or profile/report errors
fail the gate even if another report can be rendered. Reports are generated
before threshold enforcement so a low-coverage failure retains useful evidence.
The ordinary test command separately executes documentation tests; the stable
coverage run does not measure them.

The default `--workspace --all-targets --locked --no-fail-fast --no-report` cohort
remains mandatory. A second cohort uses `-p sevro --features native-bundle
--test installed_bundle --locked --no-fail-fast --no-report`. Only the new
installed-bundle target has `required-features`; existing tests are neither
feature-gated nor skipped. The collector saves each `debug/sevro` executable as
`debug/retained-coverage/<profile>/sevro` before another feature build overwrites
the ordinary path. The pinned tool discovers both saved executable mappings.
Separate `default-%p-%m.profraw` and `native-bundle-%p-%m.profraw` names identify
the required raw cohorts. LLVM owns merging and every reported counter.

An explicit orchestration guard requires successful statuses for both test
commands, nonempty raw cohorts, and unchanged saved executable hashes. LLVM does
not provide that completeness guarantee itself. JSON, LCOV, HTML, and threshold
commands must expose identical object sets in their verbose invocations. Extra
objects are not injected through `LLVM_COV_FLAGS`: the pinned tool does not pass
that variable to its internal threshold export. Combined reports retain the
authored/reported source inventory, including the bundle source, with the same
production filters and 95% gates. Unmapped source files still require review;
the inventory is not an exemption list.

Both cohorts are attempted even when the first test command fails. Reports and
available mappings/profiles remain diagnostic evidence, and the overall command
fails for any missing cohort, input, mapping, test failure, or threshold failure.
The output retains command/status receipts, mapping hashes, raw counters, and
content-addressed copies of every final report object for later inspection.

[The feature control](../../scripts/rust/test-feature-coverage.py) uses the same
collector with a real small compiler fixture. Default-only coverage is 9/10
lines; adding the bundle produces 14/15 lines; executing the remaining default
outcome produces 15/15. The first two line gates fail and the last passes. On the
pinned nightly, the corresponding supported branch counts are 1/2, 3/4, and 4/4.
Both profiles' authored files remain in the combined inventory, and removing a
raw cohort or saved executable fails the explicit completeness guard. These
controls also invoke the public collector with a genuinely failing default test
after every source outcome executes: the bundle cohort still runs, the counters
reach 100%, and the failed test status still refuses acceptance. Controls run on
both CI platforms and do not supply Sevro production coverage.

## Compiler branch outcomes

An additional gate requires at least 95% of LLVM's supported branch outcomes,
independently of the stable line and region gates. It pins
`nightly-2026-10-15`: Rust `1.101.0-nightly`, compiler commit
`7df81381d027710708209f36b98d11b1c88f8d2e`, and LLVM 23.1.3. This nightly is
used only for branch measurement; it does not change `rust-toolchain.toml` or
the stable build and lint requirements.

Install the nightly and use a separate target directory so its profiles cannot
mix with stable coverage. The commands require Python 3 and jq in addition to
the compiler coverage tool already installed above:

```sh
rustup toolchain install nightly-2026-10-15 --profile minimal --component llvm-tools-preview
python3 scripts/rust/test-branch-coverage.py --toolchain nightly-2026-10-15 --output-dir .coverage/branches/controls
python3 scripts/rust/test-feature-coverage.py --toolchain nightly-2026-10-15 --branch --output-dir .coverage/branches/feature-controls
python3 scripts/rust/coverage-profiles.py --toolchain nightly-2026-10-15 --branch --output-dir .coverage/branches/profiles --target-dir target/llvm-cov-branches
```

The control command requires a new output directory. Use a fresh directory for
each diagnostic run so earlier reports remain separate. CI gives stable and
nightly their own jobs and output directories. The nightly collector adds
`--branch` to both required test cohorts; its combined report passes the unchanged
jq branch gate as well as the tool's line/region checks.

The pinned tool exports branch counters but supplies no branch threshold flag.
[The jq gate](../../scripts/rust/branch-coverage.jq) checks the compiler's raw
`count`, `covered`, and `notcovered` values with
`covered * 100 >= count * 95`; it ignores the displayed percentage. It requires
one document, one dataset, the pinned tool/export format, consistent nonnegative
integer counters, and a nonzero denominator. Counts above 90,071,992,547,409 are
refused so both products remain exact under jq's numeric representation. Empty,
malformed, ambiguous, unsupported, or incomplete reports fail. The gate does not
discover branches or alter the compiler's denominator.

[The control suite](../../scripts/rust/test-branch-coverage.py) checks exact 95%
acceptance, a just-below-threshold refusal, misleading display percentages,
missing/invalid/inconsistent counters, unsafe arithmetic, and malformed or
multiple documents. It then compiles a real negative fixture before an
independent positive fixture: the expected measurements are 1/2 and 2/2 branch
outcomes. Each run has its own clean profile directory. Fixture sources, raw
profiles, reports, gate output, tool versions, logs, and the control summary are
retained. These tool controls do not contribute coverage to Sevro production.

The compiler's denominator has limits. The checked construct fixture records
the following results and refuses unexpected changes on either CI platform:

| Construct in the control fixture    | Branch outcomes |
| ----------------------------------- | --------------: |
| `if`, `if let`, `let else`, `while` |          2 each |
| Boolean `if a && b \|\| c`          |               6 |
| Standalone `a && b`                 |               2 |
| Match guard                         |               2 |
| The fixture's macro-expanded `if`   |               2 |
| Plain match arms and or-patterns    |               0 |
| `?` early return                    |               0 |
| `.await`                            |               0 |

These counts were measured with the pinned compiler on macOS arm64; each hosted
platform must produce its own passing controls. The macro result establishes
only the specific tested expansion. Changes to the pin or construct behavior
require inspecting the resulting counters and updating this explicit contract.
The [upstream tracking issue](https://github.com/taiki-e/cargo-llvm-cov/issues/8)
describes the unstable branch option, and Rust maintains
[documented construct limitations](https://github.com/rust-lang/rust/issues/124118).

This metric is not full TypeScript-equivalent branch coverage. Match arms,
early-return outcomes, asynchronous lifecycle behavior, and macro expansions
still need meaningful public-seam regression tests; line and region coverage
remain independently required. Preserve the existing TypeScript statement and
branch gates until their complete replacement is demonstrated. A passing LLVM
branch threshold alone cannot establish full port parity.

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

The opt-in `native-bundle` profile additionally runs the shipped graded example
through its shipped adapter from a fresh external bundle. Tests bind retained
runner identity to an independent executable-and-assets receipt, verify
relocation and changed assets, and refuse missing or unsafe layout without
replacing prior results. The [installation ledger](rust-tdd-installation.md)
records this bounded public seam. It does not establish npm cutover, publication,
or every installed workflow required by the delivery specification.

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
The profile collector retains both test statuses, exact report object mappings,
their checksums and executable bytes, and the combined authored-source inventory.
Artifacts upload even after failure; their presence alone does not mean checks
passed. A checkout or tool-installation failure may leave only partial evidence.

Separate nightly jobs explicitly install jq and check Python 3 on both platforms.
They retain `.coverage/branches`, compiler
identity, LLVM profiles, raw branch counters, LCOV/HTML, enforcement output, and
the full control evidence. Their artifact names also identify the exact source
SHA, platform, and workflow attempt. No report or control from another candidate
can replace a missing result.

All stable and nightly matrix jobs must succeed for the stable `Rust quality`
status. A cancelled, skipped, failed, or missing platform cannot establish success. The coordinator
must observe the exact published head's required statuses, including the existing
TypeScript gate, and repair in-scope failures before claiming delivery. The
workflow does not publish binaries, npm packages, Git tags, or releases.
