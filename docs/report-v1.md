# Generic report v1

`sevro report` reads one or more retained `sevro.cli-result.v1` files and their
referenced `sevro.run-evidence.v1` files. It validates both public schemas and
checks run identity, exit category, case count, and trial references before
reporting. Paths must be absolute and distinct.

```sh
sevro report --result-file /absolute/path/to/result.json
sevro report --json --result-file /absolute/path/to/first.json \
  --result-file /absolute/path/to/second.json
```

The default output is Markdown. `--json` emits one `sevro.report.v1` document,
defined by [`report-v1.schema.json`](../schemas/report-v1.schema.json). Invalid
inputs return exit 64 with a diagnostic on stderr. Reporting does not change
the exit category of any input run; each row retains its original code.
Pre-run failures with no case rows remain visible in the input-run section.

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
