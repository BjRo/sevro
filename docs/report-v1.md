# Generic report v1

`sevro report` reads one or more retained `sevro.cli-result.v1` files and their
referenced `sevro.run-evidence.v1` files. It validates both public schemas and
checks run identity, exit category, case count, and trial references before
reporting. Programmatic `createReport` paths must be absolute and distinct.
CLI `--result-file` paths may be relative to the invoking directory; they are
canonicalized before duplicate detection and loading.

```sh
sevro report --result-file /absolute/path/to/result.json
sevro report --latest
sevro report --latest --results-root ./other-results
sevro report --json --result-file /absolute/path/to/first.json \
  --result-file /absolute/path/to/second.json
```

The default output is Markdown. `--json` emits one `sevro.report.v1` document,
defined by [`report-v1.schema.json`](../schemas/report-v1.schema.json). Invalid
inputs return exit 64 with a diagnostic on stderr. Reporting does not change
the exit category of any input run; each row retains its original code.
Pre-run failures with no case rows remain visible in the input-run section.

`--latest` selects
`<cwd>/.sevro/results/latest.json`; `--results-root` changes that root and requires
`--latest`. It is exclusive with `--result-file`. Each retained CLI evaluation
saves a `result.json` beside its run evidence and atomically updates latest,
including dry and failed runs. Pre-run failures do not replace latest. Missing
latest or referenced evidence is an error. See
[the evaluation workflow](evaluation-workflow.md).

[`sevro prune`](reading-results.md#prune-retained-results) maintains this index
when removing retained evidence. After pruning, latest selects the newest
remaining completed result; if none remain, the index is removed and `--latest`
reports a missing-input diagnostic. Explicit reports still require their selected
results and evidence to exist.

Each case row keeps task verdict, execution, and grading separate. Task pass
rate is measured only when every trial completed execution and grading with an
assessed task verdict. Candidate duration sums the measured host call time
across trials. Tokens and cost are totals only when every trial has complete
usage and that measurement is present. Dry trials, incomplete usage, absent
provider cost, and historical results without duration show `null` in JSON and
`unknown` in Markdown. Missing values never become zero. The report retains
exact candidate, semantic, and advisory routes and lists domain outcomes
separately from the task verdict.

Rows are descriptive, not matched comparisons. Darrow's skill activation,
ablation matching, and benchmark interpretation remain repository policy and
require their own report layer over these generic results.
