# Sevro

<p align="center">
  <img src="docs/assets/sevro-logo.png" alt="Sevro logo: a black S-shaped track with red segments above the sevro wordmark" width="360">
</p>

Sevro runs repeatable evaluations of coding agents. Give it a case, a host
adapter, and success criteria; it retains execution, grading results, and
evidence. Projects own their benchmark cases and policy through Sevro's
[extension boundary](docs/extension-protocol-v1.md).

Sevro grew out of [Darrow](https://github.com/BjRo/darrow), but works without a
Darrow checkout. Try [your first evaluation](docs/getting-started.md): no model
account is required.

## Status and environments

Sevro is under active development. The npm package is `@bjoernrochel/sevro`;
its command is `sevro`. On 2026-10-07 the published default is `0.1.0-rc.2`.
This checkout contains unreleased changes and different licensing terms.
Installing `rc.2` does not install this README or the new license.
See [installation and release differences](docs/installing.md).

Use Bun 1.3.13. The full deterministic suite and native isolation target macOS;
bundled Codex/Claude routes and isolated shell checks need `sandbox-exec`.
Contributor package/release checks also need Node 24 and npm.
Linux and Windows support is unverified. The basic example uses an injected
deterministic adapter and needs no native model credentials.

## Install and get a first result

```sh
mkdir sevro-demo
cd sevro-demo
bun init -y
bun add --exact @bjoernrochel/sevro@0.1.0-rc.2
```

Continue with [your first evaluation](docs/getting-started.md): the exact command,
expected `passed` result, and retained evidence. Read [installation](docs/installing.md)
for updates, removal, and source checkouts.

## Find your next task

The [documentation hub](docs/README.md) routes to running evaluations, authoring
cases and extensions, reading results, troubleshooting, and architecture.
Public v1 contracts are the [extension protocol](docs/extension-protocol-v1.md),
[results and evidence](docs/results-v1.md), and [report](docs/report-v1.md).
Machine-readable contracts live in [schemas/](schemas/).

## Ask the repository guide

Open this checkout in a fresh Codex or Claude Code session and ask
“What is Sevro, and how do I run my first evaluation?” Explicit invocation is
`$sevro-guide` in Codex or `/sevro-guide` in Claude Code.
The guide reads sources, cites its answers, and handles follow-ups. It explains
commands; execution requires a separate request. See the
[guide contract and verification limits](docs/specs/repository-guide.md).
The npm package does not install the repository guide.

## Contribute

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, checks, fixtures, schema
regeneration, compatibility, and releases. [Documentation quality](docs/documentation-quality.md)
defines documentation checks and review.

## License and acknowledgements

This unreleased checkout uses the [Sevro Source Available License 1.0](LICENSE).
Use is free in every context, including commercial work and paid education.
Selling copies, rebranded versions, or hosted access to Sevro's functionality
requires a separate license. Modification and free redistribution remain allowed.
It is source-available, not an OSI open-source license. Read
[licensing](docs/licensing.md) for contribution grants and earlier BSL releases.

Björn Rochel created the logo. Sevro's name is inspired by the character in
Pierce Brown's _Red Rising_. Thank you, Pierce Brown, for the world and characters
that inspired both Sevro and Darrow. See [acknowledgements](docs/acknowledgements.md).
