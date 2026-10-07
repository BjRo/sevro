# Troubleshooting

Start with execution, grading, task states, and stderr. A documented possible
cause is not a diagnosis of your machine.

| Symptom                                   | Check and next step                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command cannot run                        | Use Bun 1.3.13 and verify the local package/version. Read [installation](installing.md).                                                                  |
| Project snapshot contains a symbolic link | Use a separate evaluated project directory as in [the tutorial](getting-started.md); do not include installed dependencies in a plain-directory snapshot. |
| Exit 0 but no passing task                | Prompt-only/dry runs are `not_assessed`. Read [results](reading-results.md).                                                                              |
| Exit 64 before execution                  | Check absolute paths, exclusive route options, configuration, and capabilities in the [CLI reference](development-cli.md).                                |
| Grading unavailable                       | Inspect required evidence/completeness in [results v1](results-v1.md).                                                                                    |
| Native authentication fails               | Check the exact release and private credential route. Read [native hosts](native-hosts.md).                                                               |
| Native or shell isolation fails           | Verify macOS and `sandbox-exec`. Other platforms are unverified.                                                                                          |
| Extension protocol fails                  | Return one matching stdout response; diagnostics use stderr. Read [protocol v1](extension-protocol-v1.md).                                                |
| Schema freshness fails                    | Run `bun run schemas:generate`, then `bun run schemas:check`, from a checkout.                                                                            |
| External links fail                       | Follow [network failure triage](documentation-quality.md#external-links).                                                                                 |

## The repository guide is missing

The guide belongs to a source checkout, not npm. Start a fresh session at the
repository root. Check `.agents/skills/sevro-guide/SKILL.md` for Codex and
`.claude/skills/sevro-guide/SKILL.md` for Claude. Invoke `$sevro-guide` or
`/sevro-guide` respectively. See [host entrypoints](specs/repository-guide.md#host-entrypoints).
`bun run check:docs` checks adapters, not native discovery; use [guide evals](guide-evaluation.md).
Explanation does not authorize live diagnosis or repair.

If these checks do not resolve the issue, open a [Sevro issue](https://github.com/BjRo/sevro/issues)
with version, platform, sanitized command, states, and bounded diagnostics.
Keep credentials, private case content, and raw host artifacts out of it.
