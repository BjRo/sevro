# Sevro glossary

Sevro runs coding agents against declared cases in isolation and retains
evidence of what happened. This glossary fixes the words used for those
concepts across code, documentation and architecture reviews.

## Evaluation

**Case**:
One declared task for an agent: a prompt, a fixture and the criteria that grade the result.
_Avoid_: test, scenario, benchmark item

**Candidate**:
The agent configuration being evaluated: a host with its model, effort and any mounted skills or plugins.
_Avoid_: participant, subject, model under test

**Fixture**:
The prepared working tree a trial starts from, containing only what the candidate may see.
_Avoid_: sandbox, test repo

**Workspace**:
The fixture's materialized directory that one trial's candidate works in.
_Avoid_: checkout, working copy

**Run**:
One evaluation of a single case by one candidate, repeated over its trials and summarized as one result against the case's pass threshold.
_Avoid_: job, session

**Trial**:
One repetition of a case within a run, with its own fixture, candidate execution, grading and evidence.
_Avoid_: sample, iteration; attempt (a retained run)

**Extension**:
A project-owned process that prepares case inputs and supplies policy, such as skill mounts or custom grading, through the extension protocol.
_Avoid_: plugin (reserved for host plugins), adapter

**Runtime policy**:
The project's declaration of which host tools, read-only roots, caches, hooks and network access each runtime role may use.
_Avoid_: sandbox config, environment

**Runtime role**:
The purpose a native execution serves: candidate, checks, hooks, semantic or advisory.
_Avoid_: mode, phase

## Grading and results

**Check**:
One graded criterion of a case that resolves to passed, failed or unavailable.
_Avoid_: assertion, test

**Grader**:
The kind of judgment that evaluates a check: output, shell, Git HEAD, semantic or extension-supplied.
_Avoid_: judge (reserved for advisory review), validator

**Semantic check**:
A check graded by a separate model reading the candidate's response against a stated criterion.
_Avoid_: LLM judge, AI grading

**Advisory review**:
An optional, independent model review of a completed trial whose recommendation never changes the task verdict.
_Avoid_: judge verdict, second opinion

**Verdict**:
The three separate states of a trial or run: execution, grading and task.
_Avoid_: score, pass/fail (alone)

**Observation**:
A namespaced, bounded fact a host or grader reports about a trial, with explicit completeness.
_Avoid_: log, metric, event

**Attempt**:
One run's retained result directory in a results root, counted and pruned as a unit whether it passed, failed or was interrupted.
_Avoid_: trial, execution

**Evidence**:
The retained, atomically written record of a trial or run from which results can be re-read and reported.
_Avoid_: logs, artifacts (alone), output

## Hosts

**Host**:
The agent program a trial runs, such as Codex or Claude Code, or a custom executable.
_Avoid_: harness (Darrow's word for the same thing; in Sevro it means test scaffolding), runner, provider

**Native host**:
A host Sevro launches as its real CLI inside private state and isolation, rather than a custom executable; it supplies its own admission, preparation and turn interpretation to each native host request.
_Avoid_: real host, live host, native run adapter

**Host adapter**:
The public interface through which the engine sends any host one host request and receives its host result.
_Avoid_: driver, connector; do not use for the per-host part of a native host request

**Native host request**:
One request for a native host to do its work once (a trial's candidate, a semantic check or an advisory review), carried out in its own private state through admission, preparation, one or two turns, evidence retention and cleanup; a run contains many of them.
_Avoid_: native run, harness request, host execution

**Native transcript**:
The host's own record of a native host request, retained as evidence when the runtime policy enables it.
_Avoid_: session log, chat history

**Native control**:
A host-native orchestration call, such as spawning or messaging an agent, reported as an observation for extension policy.
_Avoid_: tool call (too broad), subagent call

**Native goal**:
A host's built-in objective-tracking mechanism, enabled through runtime hooks and observed rather than simulated.
_Avoid_: task goal, objective

**Continuation**:
A second, follow-up turn delivered to the same native session within one trial.
_Avoid_: retry, second run

## Skills

**Skill**:
A packaged instruction set a host can load, provided by the repository or by a host plugin.
_Avoid_: prompt, agent, command

**Skill activation**:
Observed evidence that the candidate actually loaded a skill during a trial.
_Avoid_: skill usage, trigger

**Skill exposure**:
Whether, and how completely, a skill's body was available to the candidate, reported separately from collection health.
_Avoid_: visibility, availability

**Skill invocation**:
A case's explicit instruction that the candidate call a declared skill by its host-specific token, from either a repository or a host plugin.
_Avoid_: skill call, mention

## Isolation

**Protected root**:
A path the candidate and grading commands must neither read nor write, such as the project source, results or another fixture.
_Avoid_: blocked path, denied dir

**Private state**:
The host-owned directory that holds a native host request's credentials, configuration and transcripts outside the workspace.
_Avoid_: temp dir, home

**Isolation policy**:
The single validated statement of what an isolated command or host may deny, read and write, and which network access it has.
_Avoid_: sandbox profile, permissions

**Policy renderer**:
A translation of one isolation policy into a native enforcement format, such as a macOS sandbox profile, Linux bubblewrap arguments, a Codex permission profile or Claude settings.
_Avoid_: sandbox builder, profile generator
