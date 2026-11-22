# Sevro documentation

<img src="https://raw.githubusercontent.com/BjRo/sevro/main/docs/assets/sevro-wordmark.svg" alt="Sevro wordmark" width="220">

Start with [your first evaluation](getting-started.md), then choose a task.

## Evaluate

- [Initialize, run, and iterate](evaluation-workflow.md)
- [Run evaluations and select a host](running-evaluations.md)
- [Create cases and extensions](creating-cases.md)
- [Try runnable recipes](recipes.md)
- [Read results and evidence](reading-results.md)
- [Troubleshoot a failure](troubleshooting.md)

## Configure and integrate

- [Install, update, or remove Sevro](installing.md)
- [CLI options and defaults](development-cli.md)
- [Use the embedding API](embedding-api.md)
- [Run native hosts](native-hosts.md)
- [Configure tools, goals, and hooks](runtime-v1.md)
- [Save run settings](run-settings-v1.md)

## Understand and contribute

- [Architecture](architecture.md) and [glossary](../GLOSSARY.md)
- [Public contracts](contracts.md) and [schemas](../schemas/)
- [Built-in graders](builtin-graders-v1.md)
- [Contributing](../CONTRIBUTING.md)
- [Licensing](licensing.md) and [assets](assets/README.md)

## Ask the guide

Ask ordinary Sevro questions in a fresh repository session, or use `$sevro-guide`
in Codex and `/sevro-guide` in Claude Code. The
canonical guide at `.agents/skills/sevro-guide/SKILL.md` reads evidence and
explains it; it does not run installations, tests, or evaluations.
It belongs to this repository, not an npm installation.

## Sources and authority

[Current contracts](contracts.md) define interfaces. The
[guide specification](specs/repository-guide.md) defines the repository assistant.
[Historical validation](https://github.com/BjRo/sevro/blob/main/docs/evidence.md) records observations, not current guarantees.
There is no accepted Rust migration decision here;
[issue #2](https://github.com/BjRo/sevro/issues/2) tracks research.

Read [documentation quality](documentation-quality.md),
[the usability study protocol](https://github.com/BjRo/sevro/blob/main/docs/usability-study.md),
[guide evaluation](guide-evaluation.md), [releases](releases.md), and
[acknowledgements](acknowledgements.md) for maintenance.
Return to the [Sevro introduction](../README.md).
