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
