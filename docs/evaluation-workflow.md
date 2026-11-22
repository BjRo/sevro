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

Progress appears on stderr. Human output includes each trial's states, check
reasons, candidate duration, and retained paths. Add `--json` for a single
result on stdout. A completed stage does not mean the task passed; inspect
execution, grading, and task states as described in [reading results](reading-results.md).

`report --latest` reads the latest retained CLI result under
`<cwd>/.sevro/results`, including a dry run or failed assessment. Use
`--results-root ./other-results` for another root, or
`--result-file ./path/to/result.json` for a particular run. Reports require
retained evidence. See [report v1](report-v1.md) for the contract and
[reading results](reading-results.md#prune-retained-results) for retention options.

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
