# Assess the evaluation workflow

Use this protocol to assess the developer experience tracked in
[issue #53](https://github.com/BjRo/sevro/issues/53) with engineers who have not
used Sevro. The implementation handover includes this protocol; human sessions
and their measurements are deferred. No usability improvement or time saving
has been measured.

## Questions and current evidence

Measure how quickly an engineer can obtain an assessed result, adapt an
evaluation to a repository, and explain a failed check. Count documentation
detours and record where configuration or defaults are difficult to discover.

| Measure                                                   | Observed baseline | Target                                      | Observed changed workflow |
| --------------------------------------------------------- | ----------------- | ------------------------------------------- | ------------------------- |
| First credential-free assessed result, after installation | Unmeasured        | At most 60 seconds, initial research target | Unmeasured                |
| Adapt an evaluation to the participant's repository       | Unmeasured        | Not established                             | Unmeasured                |
| Understand a failing check                                | Unmeasured        | Not established                             | Unmeasured                |
| Documentation detours for each task                       | Unmeasured        | Not established                             | Unmeasured                |

Source inspection found that the original tutorial at revision `cd7542b`
required seven explicit run options, plus JSON output and redirection. That is
a description of the previous workflow, not an observed timing baseline.
Automated example tests establish command behavior on their recorded candidate;
they do not measure a new engineer's experience.

## Prepare a session

Recruit engineers unfamiliar with Sevro and record their relevant command-line,
Bun, and model-tool experience. Use a disposable copy of a small repository
they understand and a clean working directory for every task. Keep real
credentials, private source, and retained host evidence out of shared records.

Record the OS, architecture, Bun and Node versions, exact Sevro version or
checkout commit, documentation revision, and installation command. Complete
installation before starting the first-use timer. For a native repository run,
record the selected host, model, effort, authentication prerequisites, and
whether those prerequisites were already satisfied. Obtain the participant's
agreement to any model usage before that task.

Give the participant the [documentation hub](README.md) and these task goals.
Let them use CLI help and documentation. The facilitator should observe without
supplying commands. Record assistance when it occurs instead of counting an
assisted task as an unaided success. Agree on a time limit before the session;
record unfinished tasks as censored at that limit, with the blocking step.

## Tasks and success evidence

1. **See an assessed result.** Starting after installation, follow
   [Your first evaluation](getting-started.md). Stop the timer when the
   participant identifies the execution, grading, and task states and locates
   the retained evidence. A dry run, prompt-only result, or exit code `0` alone
   does not meet this goal. Record the command, result states, and evidence
   location, without copying private evidence into the study notes.
2. **Adapt it to a real repository.** Use the case-authoring and evaluation
   instructions to prepare a task for the disposable repository, with a real
   assertion and explicit candidate route. Stop when an executed assessment
   produces a result the participant can interpret. Verify that the participant
   understands how fixture content reaches the candidate; selecting a project
   root alone does not populate a fixture. Record preparation time, model wait
   time, and total elapsed time separately. If credentials or tools block the
   task, retain that outcome rather than substituting the demo as success.
3. **Explain a deliberate failure.** Use a recipe's documented failing variant.
   Stop when the participant identifies the failed check, explains its reason
   from retained evidence, and proposes the relevant correction. Record whether
   they distinguish task failure from execution failure and grader error. Then
   let them make the correction and repeat the run; record that iteration
   separately.

For each task, start timing when its goal is presented and stop at the stated
success evidence. Record raw elapsed time, pauses with their reasons, outcome,
help use, facilitator interventions, and every documentation detour. A detour
is a transition from the task's workflow page to another reference, search
result, or troubleshooting page to resolve missing information. Record the
destination and reason; repeated visits remain visible. Report the counting
definition alongside results so sessions can be compared.

## Record and interpret results

Keep one record per participant, workflow version, and task:

```text
participant_id:
workflow_version_and_docs_revision:
environment_and_prior_experience:
task_and_time_limit:
started_at:
finished_at:
elapsed_seconds:
preparation_seconds:
model_wait_seconds:
pauses_and_reasons:
outcome: completed | assisted | blocked | time_limit
execution_grading_task_states:
evidence_location_confirmed:
documentation_detours_and_reasons:
help_use_and_facilitator_interventions:
failure_explanation_and_next_iteration:
```

Leave unavailable measurements blank and label them unmeasured in reports.
Do not replace an unknown duration, usage, cost, or failed task with zero.
Report individual observations, participant count, completion counts, assistance,
and environment limits before any aggregate. Distinguish measured baselines,
observed changed-workflow values, and targets in every table.

For a comparison, preserve an executable baseline and its matching docs. Use
separate first-time participants where possible; otherwise counterbalance the
order with equivalent tasks and disclose learning effects. Small convenience
samples identify friction but do not establish a population-wide improvement.
Keep unsuccessful sessions and unresolved detours in the report.

Return to [reading results](reading-results.md) or the [documentation hub](README.md).
