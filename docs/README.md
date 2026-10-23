# Sevro documentation

<img src="https://raw.githubusercontent.com/BjRo/sevro/main/docs/assets/sevro-wordmark.svg" alt="Sevro wordmark" width="220">

Start with the task you want to complete. These pages work without an agent.

| I want to…                                     | Read                                                     |
| ---------------------------------------------- | -------------------------------------------------------- |
| Get a result without a model account           | [Your first evaluation](getting-started.md)              |
| Initialize, prepare, run and iterate           | [Evaluation workflow](evaluation-workflow.md)            |
| Install, update, remove, or use a checkout     | [Installation](installing.md)                            |
| Run evaluations and select a host              | [Running evaluations](running-evaluations.md)            |
| Create cases and reusable policy               | [Cases and extensions](creating-cases.md)                |
| Copy a complete coding, skill or runtime setup | [Runnable recipes](recipes.md)                           |
| Interpret verdicts, evidence, and comparisons  | [Reading results](reading-results.md)                    |
| Run Codex or Claude with isolation             | [Native hosts](native-hosts.md)                          |
| Reuse host tools or enable goals and hooks     | [Runtime configuration](runtime-v1.md)                   |
| Save recurring evaluation selections           | [Run settings](run-settings-v1.md)                       |
| Resolve a symptom                              | [Troubleshooting](troubleshooting.md)                    |
| Trace runner lifecycle, ownership, and changes | [Architecture](architecture.md)                          |
| Change Sevro or its documentation              | [Contributing](../CONTRIBUTING.md)                       |
| Understand licensing and branding              | [Licensing](licensing.md) and [assets](assets/README.md) |

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
