# How Sevro fits together

Sevro owns generic execution/evidence contracts. Projects own cases and policy.
This lets Darrow and other integrations use the same runner without importing
their benchmark policy into it.

| Responsibility                                    | Sources                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Parse commands/select explicit routes             | [CLI](../src/cli.ts), [CLI reference](development-cli.md)                                                          |
| Prepare, execute, grade, retain, clean up         | [Engine](../src/engine.ts), [engine slice](engine-slice.md)                                                        |
| Negotiate trusted extension calls                 | [Client](../src/extension-client.ts), [session](../src/extension-session.ts), [protocol](extension-protocol-v1.md) |
| Run native hosts and retain bounded observations  | [Codex](codex-host.md), [native controls](native-controls.md), [host sources](../src/hosts/)                       |
| Reduce execution/grading/task states              | [Result source](../src/results.ts), [contract](results-v1.md)                                                      |
| Bind comparison identities and release provenance | [Identity](identity-v1.md), [releases](releases.md)                                                                |
| Summarize retained results                        | [Report](report-v1.md)                                                                                             |

Completed evidence is retained before cleanup. Missing observations remain
unavailable; unknown measurements do not become zero. Extensions cannot
silently replace isolation/persistence or built-in policy. The
[advisory fixture](advisory-fixture.md) gives review a separate Git view with
evaluator inputs withheld.

These paths describe this checkout. [Historical validation](evidence.md) records
bounded past observations. [Rust research](https://github.com/BjRo/sevro/issues/2)
does not establish a migration; public interfaces remain useful independently.
