# Guide eval extension

`bun run eval:guide` evaluates the repository's `sevro-guide` skill through
Sevro. These modules contain project-specific cases, fixtures, and graders.
Sevro's CLI owns execution, continuation, invocation receipts, isolation,
retention, cleanup, and result output. Answer rules are declarative
`sevro.regex` checks in the case JSON; fixture integrity uses `sevro.shell`.

| File           | Responsibility                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `extension.ts` | Resolve cases, prepare skill mounts, and grade guide-specific evidence through Sevro's extension protocol. |
| `fixture.ts`   | Build missing/conflicting/stale fixture variants and declare file-integrity checks and source inputs.      |
| `evidence.ts`  | Interpret inspected sources and prohibited effect attempts from retained native events.                    |

Prompts and built-in answer checks live in `.agents/skills/sevro-guide/evals/cases.json`.
Cases and graders stay outside participant fixtures. Standard Sevro results
and private native artifacts live under ignored `.guide-results/`.

`../eval-guide.ts` only supplies the extension command, declared sources, and
repository defaults to Sevro's CLI. It forwards standard CLI options without
its own option parser, host selection, scheduler, or grading framework.
Use `--case-id` to select a case and `--adapter-module` for an explicit
deterministic Sevro adapter. Native routes use Sevro's ordinary host options.

The extension uses complete native selection and continuation observations.
Raw events remain necessary for source-content inspection and effect policy.
Claude direct skill-file reads supplement its Skill-call metadata. The
follow-up case reuses Sevro's output grader for its initial answer because
built-in engine output checks otherwise assess the final answer.

See [guide eval commands and limitations](../../docs/guide-evaluation.md).
