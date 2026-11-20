# Sevro glossary

Sevro runs coding agents against declared cases in isolation and retains
evidence of what happened. This glossary fixes the words used for those
concepts across code, documentation and architecture reviews.

## Evaluation

**Case**:
One declared task for an agent: a prompt, a fixture and the checks that grade its task.
_Avoid_: test, scenario, benchmark item

**Task**:
The work a case asks the candidate to do, as judged by the case's checks.
_Avoid_: job, goal (native goal is a separate concept)

**Candidate**:
The agent configuration being evaluated: a host with its model, effort and any mounted skills or plugins.
_Avoid_: participant, subject, model under test

**Fixture**:
The starting content a case declares for every trial: inline files, generated Git history or a repository source, plus any setup and prepared artifacts.
_Avoid_: sandbox, test repo; fixture for the materialized directory (that is a workspace)

**Workspace**:
One trial's own directory into which the fixture is materialized; the candidate works there and graders read it afterwards. Semantic grading and advisory review get their own auxiliary workspaces.
_Avoid_: checkout, working copy, participant fixture

**Run**:
One evaluation by one candidate of one or more cases (currently always one), each repeated over its trials and assessed against its pass threshold, summarized in one overall assessment.
_Avoid_: job, session

**Trial**:
One repetition of a case within a run, with its own workspace, candidate execution, grading and evidence.
_Avoid_: sample, iteration; attempt (a retained run)

**Extension**:
A project-owned process that prepares case inputs and supplies policy, such as skill mounts or custom grading, through the extension protocol.
_Avoid_: plugin (reserved for host plugins), adapter

**Runtime policy**:
The project's declaration of which host tools, read-only roots, caches, hooks and network access each runtime role may use.
_Avoid_: sandbox config, environment

**Runtime role**:
What an isolated process is for, named after what it serves: `candidate` (the candidate's turns), `checks` (shell check commands), `hooks` (runtime hook commands), `semantic` (semantic checks) or `advisory` (advisory review).
_Avoid_: mode, phase; reading a role name as the Candidate or Check concept itself

## Grading and results

**Check**:
One graded criterion of a case that resolves to passed, failed or unavailable.
_Avoid_: assertion, test

**Grader**:
The kind of judgment that evaluates a check: output, shell, Git HEAD, semantic or extension-supplied.
_Avoid_: judge (the model a semantic check runs on), validator

**Judge**:
The separate model a semantic check or advisory review runs on, kept apart from the candidate.
_Avoid_: evaluator, grader (a grader is the kind of judgment, not the model)

**Semantic check**:
A check graded by a judge reading the candidate's response against a stated criterion; the judge's per-check pass or fail answer is a semantic verdict.
_Avoid_: LLM grading, AI grading

**Advisory review**:
An optional, independent review of a completed trial by a judge, producing an advisory recommendation that never changes the task verdict.
_Avoid_: second opinion

**Advisory recommendation**:
The judge's structured opinion of a trial in an advisory review: a pass or fail recommendation, dimension scores, strengths, weaknesses and a summary.
_Avoid_: advisory assessment, advisory verdict

**Judge request**:
One request for a judge to answer a semantic check group or an advisory review, in its own auxiliary workspace, with its evidence retained under that role.
_Avoid_: grading request, review call

**Task verdict**:
The engine's decision whether a trial, case or run accomplished its task: passed, failed or not assessed. It is derived from check statuses and may be adjusted by a task-verdict policy; neither advisory review nor domain outcomes change it.
_Avoid_: verdict (alone), score, pass/fail

**Task-verdict policy**:
A named policy an extension offers and a run must explicitly select, under which the extension decides each trial's task verdict. It can override a failed check, but never a failed execution status, a grading error or missing evidence.
_Avoid_: verdict override, policy extension

**Domain outcome**:
An extension's non-gating judgment of a trial on a project-specific question, such as whether the expected skill activated, graded and retained like a check but never counted toward the task verdict, assessment or exit code; any aggregation belongs to the extension's caller.
_Avoid_: extension assessment, verdict, secondary result

**Assessment**:
The engine's three independent judgments of a trial, case or run: execution status, grading status and task verdict. Success requires all three; exit code 0 alone does not establish it.
_Avoid_: result states, verdict, result (alone)

**Observation**:
A namespaced, bounded fact a host or grader reports about a trial, with explicit completeness.
_Avoid_: log, metric, event

**Attempt**:
One run's retained result directory in a results root, counted and pruned as a unit whether it passed, failed or was interrupted.
_Avoid_: trial; run (the evaluation itself, of which an attempt is the retained directory)

**Evidence**:
The retained, atomically written record of a trial or run from which its assessment and observations can be re-read and reported.
_Avoid_: logs, artifacts (alone), output

## Hosts

**Host**:
The agent program that carries out a host request, for a trial's candidate or for a judge, such as Codex, Claude Code or a custom executable.
_Avoid_: harness (Darrow's word for the same thing; in Sevro it means test scaffolding), runner (Sevro itself), provider

**Native host**:
A host Sevro launches as its real CLI inside private state and isolation, rather than a custom executable; it supplies its own admission, preparation and turn interpretation to each native host request.
_Avoid_: real host, live host, native run adapter

**Host adapter**:
The public interface through which the engine sends any host one host request and receives its host result.
_Avoid_: driver, connector; do not use for the per-host part of a native host request

**Native host request**:
One request for a native host to do its work once (a trial's candidate, a semantic check or an advisory review), carried out in its own private state through admission, preparation, one or two turns, evidence retention and cleanup; a run contains many of them.
_Avoid_: native run, harness request, host execution

**Native session**:
The host's own conversation that carries a native host request's turns under one session id and is resumed for a continuation; its native transcript is the host's record of it.
_Avoid_: thread (Codex's word for the same thing), chat, conversation

**Native transcript**:
The host's own record of a native session, retained as evidence when the runtime policy enables it.
_Avoid_: session log, chat history

**Native control**:
A host-native orchestration call, such as spawning or messaging an agent, reported as an observation for extension policy.
_Avoid_: tool call (too broad), subagent call

**Native goal**:
A host's built-in objective-tracking mechanism, enabled through runtime hooks and observed rather than simulated.
_Avoid_: task goal, objective

**Continuation**:
The single follow-up turn a case may declare, delivered by resuming the trial's native session.
_Avoid_: retry, second run

## Skills

**Skill**:
A packaged instruction set a host can load, provided by the repository or by a host plugin.
_Avoid_: prompt, agent, command

**Skill activation**:
The event of the candidate actually loading a skill during a trial.
_Avoid_: skill usage, trigger

**Skill activation observation**:
Sevro's record of the skill activations in one trial, with explicit complete or partial collection; it states facts, not whether the right skill was chosen.
_Avoid_: activation result, activation verdict

**Skill exposure**:
Whether, and how completely, a skill's body was available to the candidate, reported in the skill activation observation.
_Avoid_: visibility, availability

**Skill invocation**:
An explicit instruction, declared by an extension and rendered into the case's prompt, that the candidate call one skill by its host-specific token, from either a repository or a host plugin.
_Avoid_: skill call, mention

## Isolation

**Protected root**:
A path the candidate and grading commands must neither read nor write, such as the project source, results or another trial's workspace.
_Avoid_: blocked path, denied dir

**Private state**:
The directory Sevro allocates for one native host request, holding its credentials, configuration and transcripts outside the workspace; the native host uses it as its home and configuration root. It is removed when its native host request ends, unless retained in the candidate runtime.
_Avoid_: temp dir, home

**Candidate runtime**:
A trial's retained candidate home plus any retained private state, kept through grading and removed with the trial.
_Avoid_: candidate home (only part of it), runtime state

**Candidate artifact**:
A named file or directory from the candidate's state that graders may read, never write, after the candidate has finished.
_Avoid_: output, artifact (alone; host artifacts are diagnostics evidence)

**Isolation policy**:
The single validated statement of what an isolated process is denied, may read and may write, and which network access it has.
_Avoid_: sandbox profile, permissions

**Policy renderer**:
A translation of one isolation policy into a native enforcement format, such as a macOS sandbox profile, Linux bubblewrap arguments, a Codex permission profile or Claude settings.
_Avoid_: sandbox builder, profile generator
