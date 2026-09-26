# Sevro

Sevro is a standalone evaluation runner for agentic coding capabilities. It is
being extracted from [Darrow](https://github.com/BjRo/darrow/issues/95). There
is no runnable release yet.

The public v1 contracts are [the extension protocol](docs/extension-protocol-v1.md)
and [run results](docs/results-v1.md). Sevro owns these generic interfaces;
projects own their cases and evaluator policy.

Machine-readable contracts live in [`schemas/`](schemas/). Run `bun install`,
`bun test`, `bun run typecheck`, and `bun run format:check` to validate them
locally.

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
adapter module or the bundled Codex route and emits a machine-readable result.
