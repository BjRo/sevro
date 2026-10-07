# Sevro

Sevro is a standalone evaluation runner for agentic coding capabilities. It is
being extracted from [Darrow](https://github.com/BjRo/darrow/issues/95). This
checkout runs locally and packs as an installable npm tarball.
The npm package is `@bjoernrochel/sevro`; its installed command is `sevro`.

The public v1 contracts are [the extension protocol](docs/extension-protocol-v1.md)
and [run results](docs/results-v1.md). Sevro owns these generic interfaces;
projects own their cases and evaluator policy.
The [generic report](docs/report-v1.md) summarizes retained public results
without treating unknown measurements as zero or inferring matched comparisons.

Machine-readable contracts live in [`schemas/`](schemas/). Run `bun install`,
`bun test`, `bun run typecheck`, `bun run format:check`, and
`bun run test:package-install` to validate the npm tarball locally. The package
test packs and installs Sevro in a temporary project, then runs the installed
CLI without a Sevro Git checkout.

Fixed contracts use checked-in validators to avoid schema compilation at CLI
startup. After editing a schema, run `bun run schemas:generate`; CI verifies
their freshness with `bun run schemas:check`.

The [release workflow](docs/releases.md) prepares a versioned artifact with its
file inventory and checksums, verifies that exact tarball, and documents manual
publication, trusted publishing, Darrow pinning, updates, and rollback.

Sevro uses the owner-selected [Business Source License 1.1](LICENSE), preserving
Darrow's terms and parameters with Sevro named as the Licensed Work. The first
published candidate was `0.1.0-rc.1`; `0.1.0-rc.2` is also published. The
`latest` distribution tag identifies the recommended default, including release
candidates. This checkout includes subsequent improvements that require a new
version before publication.

[`extension-client.ts`](src/extension-client.ts) validates one request and
response per extension process and negotiates the v1 protocol. It enforces
message limits, timeouts, response identity, and process-group cancellation.

[`extension-session.ts`](src/extension-session.ts) runs the negotiated
`resolve`, `prepare`, and `evaluate` methods and checks source stability and
evidence references. The engine accepts additive extension checks for inline
cases.

[`results.ts`](src/results.ts) reduces checks to separate execution, grading,
and task states, applies case thresholds, and maps the aggregate to a CLI exit
category.
[`identity.ts`](src/identity.ts) computes versioned comparison identities from
canonical JSON. The [identity contract](docs/identity-v1.md) defines the input
dimensions.

The [built-in output graders](docs/builtin-graders-v1.md) evaluate regex, JSON,
and inline schema assertions on bounded final-message observations.

The [first engine slice](docs/engine-slice.md) executes resolved cases through
an injected host adapter and retains trial evidence before fixture cleanup.
The [advisory review fixture](docs/advisory-fixture.md) builds a separate Git
view of the complete candidate change while withholding evaluator paths.
The [development CLI](docs/development-cli.md) runs that path with a trusted
adapter module or the bundled Codex and Claude Code routes and emits a
machine-readable result.
The [native control observation](docs/native-controls.md) exposes bounded tool
labels for extension policy on both Codex and Claude, with explicit completeness.

The packaged [basic example](examples/basic/) runs without Darrow or a model
account. From this checkout, run the graded case with:

```sh
bun src/cli.ts run --json \
  --case-file "$PWD/examples/basic/graded.json" \
  --adapter-module "$PWD/examples/basic/host.ts" \
  --project-root "$PWD" --results-root /tmp/sevro-basic-results \
  --condition passive --trials 1 --threshold 1
```

Use `prompt-only.json` in place of `graded.json` to see successful execution
with `task.verdict: not_assessed`. The package installation check runs both
cases through the installed CLI, with no Sevro source checkout present.
