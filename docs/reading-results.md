# Read results and evidence

Read all three states before calling an evaluation successful:

| Example                    | Execution | Grading       | Task         |
| -------------------------- | --------- | ------------- | ------------ |
| Declared checks satisfied  | completed | completed     | passed       |
| A check violated           | completed | completed     | failed       |
| Prompt without checks      | completed | not_requested | not_assessed |
| Successful dry preparation | not_run   | not_requested | not_assessed |

Exit `0` includes successful prompt-only/dry runs. It does not alone prove a
passing assessment. [Results v1](results-v1.md) defines errors, interruption,
aggregation, and exit-code precedence.

`--json` writes one versioned result to stdout; diagnostics use stderr.
`evidencePath` names retained run evidence, or is `null` for pre-run failures.
Completed trial evidence is saved under `--results-root` before cleanup.
Do not assume a run-directory name or publish private host artifacts.

Human output lists each trial, failed/unavailable check
reasons, measured candidate duration, unknown/known usage and retained paths.
Preparation/candidate/grading/evidence progress appears on stderr. Stage completion
means the attempt ended; read the three result states to determine its outcome.
See the [evaluation workflow](evaluation-workflow.md) for the complete progression.

## Summarize runs

```sh
sevro report --json --result-file /absolute/path/sevro-result.json
```

`sevro report --latest` uses the most recently retained CLI result in
`<cwd>/.sevro/results`. Add
`--results-root ./other-results` to select another root. Dry/failed runs may be
latest; a pre-run error does not replace it. CLI `--result-file` also accepts
cwd-relative paths. Missing result or referenced evidence is an error, never
a fabricated row.

The command assumes [Sevro is on `PATH`](installing.md#make-the-command-available).
For a contributor checkout, use `bun src/cli.ts` in place of `sevro`.
[Report v1](report-v1.md) defines fields and limits. Missing cost, usage, or
duration is unknown, not zero. Advisory recommendations remain independent
of the task verdict.

## Prune retained results

Run `sevro prune` to permanently delete older retained evidence. With no options,
it keeps the newest **10 results** under `<cwd>/.sevro/results`. Each completed
attempt counts separately, including repeated evaluations, dry runs, failures,
and interrupted runs that retained a CLI result.

```sh
sevro prune
sevro prune --results-root ./other-results --keep 5
sevro prune --older-than 30d
sevro prune --latest
```

Choose at most one explicit policy. `--keep` accepts a positive safe integer;
`--latest` is equivalent to `--keep 1`. `--older-than` accepts a positive integer
followed by `ms`, `s`, `m`, `h`, `d`, or `w` (milliseconds through weeks). It
deletes results strictly older than that duration at invocation. Age and newest
ordering use each retained `result.json` file's modification time; copying or
editing that file can change its retention age. Equal timestamps sort by
absolute result-directory path, ascending. Relative roots resolve from the
invoking directory.

Pruning finds retained result directories inside the selected root, including
nested `attempts` trees, validates results and their colocated run evidence, and
removes each selected result's entire directory. Directories without a retained
`result.json` are not themselves deleted. Active and unrecognized ownership states
are excluded from the retention count. Descendant directory links are not
followed; linked result, evidence, ownership and lock files are refused. The
selected root itself may be a directory alias. Invalid policies or unreadable,
malformed, inconsistent or unsafe retained inputs return exit `64` with a
diagnostic. Validation completes before any result deletion or latest update.

Pruning and CLI result publication serialize access to the root. Before deleting
evidence, pruning atomically points `latest.json` at the newest remaining
completed result, or removes the index if none remain. `sevro report --latest`
and explicit reports for surviving results keep working; reports naming deleted
results fail. An empty or missing results root is a successful no-op. Ownership
coordination metadata, partial attempts without CLI results, temporary fixtures,
and a separate `--run-state-root` remain outside evidence pruning.

## Compare carefully

[Identity v1](identity-v1.md) binds inputs, evaluator content, host/model/effort,
conditions, and fixtures. Matching labels alone do not establish matched
conditions. Historical missing fields stay unknown unless provenance establishes
them. Read [schemas](../schemas/) with the human contracts: schema validity alone
cannot establish every cross-record identity, containment, or artifact reference.
