# Run an evaluation

Begin with the [deterministic example](getting-started.md). For your own case,
make [the installed command available](installing.md#make-the-command-available),
then select a trusted adapter and absolute paths:

```sh
sevro run --json \
  --case-file /absolute/path/case.json \
  --adapter-module /absolute/path/host.ts \
  --project-root /absolute/path/project \
  --results-root /absolute/path/results \
  --condition passive --trials 1 --threshold 1
```

For a contributor checkout, use `bun src/cli.ts` in place of `sevro`.
An adapter is trusted executable code; injection does not automatically provide
native isolation. `--project-root` identifies the evaluated project, not
necessarily the runner checkout. `--results-root` receives evidence.
Trials control repetition, and the threshold controls the required pass rate.

A passive condition cannot request execution-changing instrumentation.
`--dry` prepares without execution/grading: successful preparation is still
`not_assessed`. For model routes follow [native hosts](native-hosts.md).
An [extension command](creating-cases.md) and a direct case file are exclusive.
Read [results](reading-results.md) to interpret failures and missing data.

The [detailed CLI reference](development-cli.md) owns configuration roots,
concurrency, cancellation, semantic/advisory routes, fixtures, and extra options.
Preserve its limitations when composing commands. Cancellation stops admission
and retains completed evidence before cleanup.
