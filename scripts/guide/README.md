# Guide eval extension

`bun run eval:guide` evaluates the repository's `sevro-guide` skill through
Sevro. These modules contain project-specific cases, fixtures, and graders.
Execution, continuation, invocation receipts, isolation, evidence retention,
and cleanup use the ordinary Sevro engine and bundled host adapters.

| File                             | Responsibility                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `cli.ts`                         | Select the host, model, cases, and bounded case concurrency.                                            |
| `evaluation.ts`                  | Connect the extension to `runEvaluation`, record workspace fingerprints, and save standard CLI results. |
| `extension.ts`                   | Implement the existing extension protocol's discovery, resolution, preparation, and grading methods.    |
| `fixture.ts`                     | Declare current repository inputs, both skill mounts, and missing/conflicting/stale fixture variants.   |
| `grading.ts`                     | Assess verified native artifacts and host receipts, returning evidence-backed extension checks.         |
| `assessment.ts`, `answers.ts`    | Define guide selection, answer, source-inspection, follow-up, and boundary checks.                      |
| `observations.ts`, `commands.ts` | Interpret source reads and effect attempts from native events.                                          |
| `records.ts`, `types.ts`         | Validate the guide case inventory and define its shared types.                                          |

The case prompts live in `.agents/skills/sevro-guide/evals/cases.json`.
Cases and graders stay outside participant fixtures. Standard Sevro results
and private native artifacts live under ignored `.guide-results/`.
`--adapter-module` can supply an explicit Sevro host adapter for deterministic
integration checks; it must identify the selected Codex or Claude route.

See [guide eval commands and limitations](../../docs/guide-evaluation.md).
