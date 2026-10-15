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

Checkout/candidate human output now lists each trial, failed/unavailable check
reasons, measured candidate duration, unknown/known usage and retained paths.
Preparation/candidate/grading/evidence progress appears on stderr. Stage completion
means the attempt ended; read the three result states to determine its outcome.
See the [evaluation workflow](evaluation-workflow.md) for the complete progression.

## Summarize runs

```sh
sevro report --json --result-file /absolute/path/sevro-result.json
```

In the development checkout or a package built from it, `sevro report --latest`
uses the most recently retained CLI result in `<cwd>/.sevro/results`. Add
`--results-root ./other-results` to select another root. Dry/failed runs may be
latest; a pre-run error does not replace it. CLI `--result-file` also accepts
cwd-relative paths. Published `0.1.0-rc.11` still uses the explicit file command
above. Missing result or referenced evidence is an error, never a fabricated row.

The command assumes [Sevro is on `PATH`](installing.md#make-the-command-available).
For a contributor checkout, use `bun src/cli.ts` in place of `sevro`.
[Report v1](report-v1.md) defines fields and limits. Missing cost, usage, or
duration is unknown, not zero. Advisory recommendations remain independent
of the task verdict.

## Compare carefully

[Identity v1](identity-v1.md) binds inputs, evaluator content, host/model/effort,
conditions, and fixtures. Matching labels alone do not establish matched
conditions. Historical missing fields stay unknown unless provenance establishes
them. Read [schemas](../schemas/) with the human contracts: schema validity alone
cannot establish every cross-record identity, containment, or artifact reference.
