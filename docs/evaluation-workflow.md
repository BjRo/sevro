# From a demo to your next evaluation

Create an evaluation, prepare it, run its assertions, and inspect the latest
result with the installed `sevro` command.

## Try the demo and create a project

Use Node.js 24.13.0 or newer, or Bun 1.3.13. [Install Sevro](installing.md) and
[make its command available on `PATH`](installing.md#make-the-command-available),
then run:

```sh
sevro demo
sevro init --template response --directory ./response-evaluation
cd response-evaluation
```

The demo returns an assessed `passed` task and evidence under `.sevro/results`,
using its own temporary project without credentials. The initializer refuses
existing destinations, including directories and symbolic links. It writes
real assertions, a deterministic adapter, `run.json` and template instructions.
[Saved settings](run-settings-v1.md) use their manifest's directory for paths;
`sevro.json` retains its separate runtime scope. Keep private `.sevro/` out of Git.

## Prepare before execution

```sh
sevro run --run-manifest-file run.json --dry
```

Stderr shows the whitelisted resolved settings before candidate execution:
case/source selection, routes/model/effort, trials, threshold, concurrency,
runtime selection and canonical storage paths. Invalid input names its option,
file or field; missing executables name installation or explicit override paths.
Correct the named prerequisite and repeat preparation.

Dry preparation follows normal fixture, extension and check preparation without
calling the candidate or graders. Expect
`execution=not_run grading=not_requested task=not_assessed`. It does not establish
authentication, provider model availability, native skill dispatch or model success.
See [native prerequisites](native-hosts.md) and [troubleshooting](troubleshooting.md).

## Run, read and change one thing

```sh
sevro run --run-manifest-file run.json
sevro report --latest
SEVRO_TEMPLATE_FAIL=1 sevro run --run-manifest-file run.json
sevro report --latest
```

The first run's adapter returns exactly `ready`; its regex assertion must pass.
The negative control returns `wrong`: expect exit `1`, completed execution and
grading, task `failed`, and the named `ready` check's reason. Then edit `case.json`
and `adapter.js` (`adapter.ts` when initialized from contributor sources), prepare again and rerun. Explicit flags override saved settings;
`--trials 3` repeats the task without rewriting `run.json`.

Progress uses stderr at actual preparation, candidate, grading and evidence
retention boundaries. Trial numbers distinguish concurrent work, which may
interleave. Stage `completed` means the attempt finished; the result states whether
execution/grading succeeded. Dry runs explicitly skip candidate and grading;
failed candidates skip grading. Failed preparation never prints candidate start.
Evidence completion follows persistence. Optional synchronous engine observers
cannot change the result through a thrown exception.

Human completion shows per-trial states, failed/unavailable check reasons,
measured candidate time, known/unknown usage/cost and `result=`/`evidence=` paths.
Candidate time measures the host call, not total setup time. Absent metrics remain
`unknown`; dry duration is unknown. Prompt-only completion stays `not_assessed`.
Add `--json` to emit one `sevro.cli-result.v1` stdout document; progress remains on
stderr. See [reading results](reading-results.md).

Each retained CLI evaluation saves `result.json` beside its run evidence and
atomically publishes `<results-root>/latest.json`. Latest is the last retained CLI
result, including dry runs and failed assessments. Pre-run failures do not replace
it. Concurrent runs publish in completion order. Output files stay under excluded
results storage, preserving project identity. A latest-write failure cannot turn
an earlier failed assessment into success.

`report --latest` reads `<cwd>/.sevro/results/latest.json`. Use
`report --latest --results-root ./other-results` for another output root or working
directory. `--result-file ./path/to/result.json` selects older runs and accepts
relative paths. Reports validate referenced evidence; missing/moved evidence
produces a diagnostic. To reclaim native bundle space while keeping reportable
results and hashes, use [`sevro prune --native-transcripts`](reading-results.md#remove-native-transcript-bundles).
Reports label bundles intentionally removed by that command as pruned.
[Report v1](report-v1.md) defines fields and limits.

## Choose another starter

| Template           | Real assertions                                                                                                    | Prerequisites and interpretation                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `response`         | Exact `ready` response; negative control returns `wrong`                                                           | Node or Bun; no model credentials                                                                                  |
| `coding`           | Edit `add.sh`; isolated checks test positive, negative and zero addition                                           | Node or Bun plus `sandbox-exec` on macOS or `bubblewrap`/`socat` on Linux; negative control leaves subtraction bug |
| `repository-skill` | Actual `.agents/skills/startup-guide/SKILL.md` mount; explicit invocation evidence; correct start command and port | Node or Bun, Git, Codex, native isolation, explicit model/effort and readable auth file; dry is unassessed         |

From a new parent directory, use `sevro init --template coding --directory ./coding-eval`
or `sevro init --template repository-skill --directory ./skill-eval`. Read its generated
README for controls and dry/live commands. Repository-skill `command.json` records
the selected runtime executable and absolute extension path; regenerate it after moving the project.

For model evaluations, replace a saved adapter route with explicit `--host`,
`--model`, `--effort` and host authentication options. Candidate, semantic and
advisory model choices remain independent. Deterministic adapters measure wiring;
they do not measure model ability. Native runs may incur provider charges.
Automated package checks run response/coding pass/fail and native skill preparation;
authenticated native behavior and human usability remain unmeasured. The
[study protocol](https://github.com/BjRo/sevro/blob/main/docs/usability-study.md) records deferred human measurements.
[Runnable recipes](recipes.md) cover Claude, plugins/hooks, goals, semantic grading
and host tools.
