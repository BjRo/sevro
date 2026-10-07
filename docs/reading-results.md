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

## Summarize runs

```sh
bun src/cli.ts report --json --result-file /absolute/path/sevro-result.json
```

For installed packages use `bun node_modules/.bin/sevro` instead of `bun src/cli.ts`.
[Report v1](report-v1.md) defines fields and limits. Missing cost, usage, or
duration is unknown, not zero. Advisory recommendations remain independent
of the task verdict.

## Compare carefully

[Identity v1](identity-v1.md) binds inputs, evaluator content, host/model/effort,
conditions, and fixtures. Matching labels alone do not establish matched
conditions. Historical missing fields stay unknown unless provenance establishes
them. Read [schemas](../schemas/) with the human contracts: schema validity alone
cannot establish every cross-record identity, containment, or artifact reference.
