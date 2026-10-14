# Candidate Codex state validation for #73

Both requested Darrow cases passed all four original task checks and activation
in their latest single-trial invocations. [Sanitized results](results.json)
retain every live invocation's identity and check statuses, plus hashes of the
changed implementation inputs. Private responses, rollouts and diagnostics
remain under the ignored `.quality/issue73/` directory.

## Native cases

Validation used macOS arm64, Codex CLI 0.162.1, the `app-server` entrypoint,
requested candidate `gpt-6.1-sol/medium`, requested semantic grader
`gpt-6-luna/medium`, passive owner evaluation, N=1 per invocation, jobs=1,
threshold=1 and a 1,200,000 ms Codex deadline.

Repair reruns initially kept that semantic route. After repeated false negatives
on responses explicitly reporting effective capacity `8`, the final matched pair
uses semantic grader `gpt-6.1-sol/medium` with the same cases and checks.

| Invocation     | Case                                        | Task checks | Activation | Result                                                       |
| -------------- | ------------------------------------------- | ----------- | ---------- | ------------------------------------------------------------ |
| `doctor-01`    | `doctor-adaptive-goal-direct-codex`         | 2/4         | Passed     | Failed: missing offline `hatchling==1.32.3`                  |
| `doctor-02`    | `doctor-adaptive-goal-direct-codex`         | 3/4         | Passed     | Failed: semantic false negative                              |
| `doctor-03`    | `doctor-adaptive-goal-direct-codex`         | 4/4         | Passed     | Passed                                                       |
| `authoring-01` | `create-agent-skill-refuse-undefined-skill` | 4/4         | Passed     | Passed                                                       |
| `doctor-04`    | `doctor-adaptive-goal-direct-codex`         | 2/4         | Passed     | Failed: offline build dependency missing                     |
| `authoring-02` | `create-agent-skill-refuse-undefined-skill` | 4/4         | Passed     | Passed after Linux command-skill grant repair                |
| `doctor-05`    | `doctor-adaptive-goal-direct-codex`         | 2/4         | Passed     | Failed: semantic false negative; partial skill-read evidence |
| `doctor-06`    | `doctor-adaptive-goal-direct-codex`         | 3/4         | Passed     | Failed: semantic false negative                              |
| `doctor-07`    | `doctor-adaptive-goal-direct-codex`         | 4/4         | Passed     | Passed with semantic grader `gpt-6.1-sol/medium`             |
| `authoring-03` | `create-agent-skill-refuse-undefined-skill` | 4/4         | Passed     | Passed with semantic grader `gpt-6.1-sol/medium`             |

The doctor retained the fixture's `.codex/config.toml` value `99`. Operator
configuration selected concurrency `8`, which the private Codex home contained
and the response diagnosed. Backend applicability stayed unknown when current
evidence did not establish V1 or V2; concurrency and nesting remained distinct.
The repository stayed unchanged and orchestration did not activate.

The first failure was an incomplete prepared dependency cache. Locked runtime
dependencies were prepared before retrying. In the second trial, the response
explicitly reported effective capacity `8`, but the semantic grader said it
reported only the recommendation `4`. The unchanged case and checks were rerun;
the third trial passed. These observations do not establish a stability rate.

After the Linux repair, `doctor-04` again could not find the offline build
dependency. Preparing only runtime dependencies can reuse an existing local
environment without caching `hatchling`; preparation now includes the locked
development group so each fresh isolated backend can build offline.

`doctor-05` reported effective capacity `8`, but its semantic check missed that
claim and the skill-read trace was partial. `doctor-06` again reported `8` and
retained complete native evidence; the capacity check still produced a false
negative. The original requirements were preserved throughout these invocations.

The undefined-skill case kept its repository-preservation, no-commit,
missing-contract and activation checks. Its user-skill check now requires all
four original candidate skill roots rather than retired `.git/darrow-eval/state`
or the grader's home. The absence oracle's six deterministic cases accept real
empty state, detect creation in each root and refuse missing evidence. Darrow's
37 integration tests passed against the Sevro checkout.

## Downstream migration

The [Darrow migration patch](darrow-migration.patch) comes from local commit
`40603998` on `fix/73-sevro-codex-validation`, based on the ticket's local
`fix/pr257-validation` checkpoint. It adds the runtime selection, migrates the
absence oracle, tests positive and negative states, documents the selection and
updates both authoring plugin manifests. Existing validation worktrees and their
unpublished repairs were preserved. The capacity `8` override is local validation
configuration and is excluded from that commit and patch.

Apply the patch in that Darrow checkout, install its locked dependencies, and
prepare the public dependency cache before native execution:

```sh
export SEVRO_CHECKOUT=/absolute/path/to/sevro-candidate
export UV_PYTHON_INSTALL_DIR="$(uv python dir)"
UV_DEFAULT_INDEX=https://pypi.org/simple UV_CACHE_DIR="$HOME/.darrow/cache/sevro-uv-cache" uv sync --locked --group dev --project plugins/orchestration/darrow-adaptive-goal/backend
UV_DEFAULT_INDEX=https://pypi.org/simple UV_CACHE_DIR="$HOME/.darrow/cache/sevro-uv-cache" uv sync --locked --group dev --project plugins/foundation/darrow-skill-authoring/backend
bun eval --harness codex --skill doctor-adaptive-goal --case doctor-adaptive-goal-direct-codex \
  --codex-entrypoint app-server --model gpt-6.1-sol --effort medium \
  --semantic-check-model gpt-6.1-sol --semantic-check-effort medium \
  --owner-evaluation passive --trials 1 --jobs 1 --threshold 1 \
  --results-root "$PWD/evals/results/codex-state-doctor" -- \
  --codex-timeout-ms 1200000 --retain-host-diagnostics \
  --runtime-config-file "$PWD/evals/sevro-extension/runtime-codex-state.json"
bun eval --harness codex --skill create-agent-skill --case create-agent-skill-refuse-undefined-skill \
  --codex-entrypoint app-server --model gpt-6.1-sol --effort medium \
  --semantic-check-model gpt-6.1-sol --semantic-check-effort medium \
  --owner-evaluation passive --trials 1 --jobs 1 --threshold 1 \
  --results-root "$PWD/evals/results/codex-state-authoring" -- \
  --codex-timeout-ms 1200000 --retain-host-diagnostics \
  --runtime-config-file "$PWD/evals/sevro-extension/runtime-codex-state.json"
```

This is source-checkout evidence; published rc.11 does not support `codexState`.
The [runtime contract](../../runtime-v1.md#candidate-codex-configuration-and-user-skills)
defines the grants, native/command-home distinction, limits and cleanup.

## Test-first regressions

Each red ran with the behavior still missing; each green used the identical
literal command after its implementation slice:

```text
Red — bun test ./tests/runtime-host.test.ts -t "Codex state opt-in exposes actual configuration": expected configured, received unavailable.
Green — bun test ./tests/runtime-host.test.ts -t "Codex state opt-in exposes actual configuration": 1 passed.
Red — bun test ./tests/runtime-host.test.ts -t "Codex state opt-in keeps checkout configuration inert": fixture Codex configuration is unsupported.
Green — bun test ./tests/runtime-host.test.ts -t "Codex state opt-in keeps checkout configuration inert": 1 passed.
Red — bun test ./tests/runtime-host.test.ts -t "Codex state grading observes actual user-skill creation": expected exit 0, received 1.
Green — bun test ./tests/runtime-host.test.ts -t "Codex state grading observes actual user-skill creation": 1 passed.
Red — bun test ./tests/runtime-host.test.ts -t "Codex state grading observes agent-home skill creation": expected exit 0, received 1.
Green — bun test ./tests/runtime-host.test.ts -t "Codex state grading observes agent-home skill creation": 1 passed.
Red — bun test ./tests/runtime-host.test.ts -t "runtime configuration opts into candidate-bound Codex state": invalid runtime configuration schema.
Green — bun test ./tests/runtime-host.test.ts -t "runtime configuration opts into candidate-bound Codex state": 1 passed.
Red — bun test ./tests/runtime-host.test.ts -t "Codex state grading observes command-home skill creation": expected exit 0, received 1.
Green — bun test ./tests/runtime-host.test.ts -t "Codex state grading observes command-home skill creation": 1 passed.
Red — bun test ./tests/runtime-host.test.ts -t "Codex state keeps bundled system skills read-only": expected protected, received writable.
Green — bun test ./tests/runtime-host.test.ts -t "Codex state keeps bundled system skills read-only": 1 passed.
Red — bun test ./tests/runtime-host.test.ts -t "Codex state grading refuses config-directory evidence": expected exit 3, received 1.
Green — bun test ./tests/runtime-host.test.ts -t "Codex state grading refuses config-directory evidence": 1 passed.
```

Further integration coverage exercises absence, unsafe/missing evidence,
credential denial, read-only grading, failure/cancellation cleanup, concurrent
trials and refusal to reuse a native state binding. No integration tests were
removed. Full acceptance remains the GitHub CI gate on the published candidate,
as required by [Contributing](../../../CONTRIBUTING.md).

## Linux CI repair

The [first published CI run](https://github.com/BjRo/sevro/actions/runs/38564333137)
retained 1,871 passing tests, 28 platform skips and five failures around the
command-home skill directories. A non-root Ubuntu 24.04 arm64 reproduction with
CI's pinned Codex 0.160.1 confirmed that HOME was correct, but the existing
`.agents/skills` and `.codex/skills` directories remained read-only despite the
enclosing HOME grant. The opt-in now grants writes explicitly to both skill
directories; credential and grading grants remain bounded.

The existing command-home integration supplied the Linux red/green slice:

```text
Red — docker exec --user sevro --workdir /work sevro-73-linux-diagnosis env TMPDIR=/ci-tmp PATH=/tools/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin:/usr/local/bin:/usr/bin:/bin bun test ./tests/runtime-host.test.ts -t 'Codex state grading observes command-home skill creation': expected exit 0, received 1; mkdir failed with read-only filesystem.
Green — docker exec --user sevro --workdir /work sevro-73-linux-diagnosis env TMPDIR=/ci-tmp PATH=/tools/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin:/usr/local/bin:/usr/bin:/bin bun test ./tests/runtime-host.test.ts -t 'Codex state grading observes command-home skill creation': 1 passed.
```

After the repair, all 27 Codex-state integration cases passed on Ubuntu and
macOS, the fast TypeScript gate passed, and all 37 Darrow integration tests
passed again. Additional checks refuse all five reserved artifact names and
exercise semantic and advisory native grading with each combination of Codex
state and transcript selection. All four native-grading combinations passed on
both platforms, including original-path reads, write denial and credential denial.
The original native source hashes remain historical; subsequent
invocations name their repair source snapshot in [the results](results.json).
