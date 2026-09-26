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

The first runtime module, [`extension-client.ts`](src/extension-client.ts),
validates one request and response per extension process and negotiates the v1
protocol. It enforces message limits, timeouts, response identity, and
process-group cancellation. The engine and public CLI are still being built.

[`results.ts`](src/results.ts) reduces checks to separate execution, grading,
and task states, applies case thresholds, and maps the aggregate to a CLI exit
category.
[`identity.ts`](src/identity.ts) computes versioned comparison identities from
canonical JSON. The [identity contract](docs/identity-v1.md) defines the input
dimensions.
