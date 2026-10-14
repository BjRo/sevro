# Codex host integration

The default `exec` entrypoint consumes `codex exec --json` as one JSONL turn. The
`summarizeCodexEvents` parser requires one thread start and a completed turn
with a zero process exit before reporting completion. Malformed, ambiguous,
and oversized streams are errors. Missing or invalid final usage remains
incomplete and is never estimated. The last completed `agent_message` before
turn completion supplies the bounded final response; missing text stays
unavailable.

The optional `app-server` entrypoint uses the stdio app-server transport and
waits for the original root thread to complete its native turns. Its final
response comes from the completing root turn; token usage remains unknown.
Both entrypoints use the same isolated Codex home and permission-profile
preflight. See [native goal trials](development-cli.md#native-goal-trials) for
selection, native-goal observations, and follow-up behavior. The JSONL parser
rules above apply to the `exec` entrypoint.

The bounded JSONL stream is retained per trial as the private
`sevro.codex.events` host artifact. Its file URL and digest appear in trial
evidence and are available to extension grading; the stream bytes stay out of
the run JSON.
The host also retains a bounded `sevro.codex.skill-reads` observation. It
records the first verified mounted skill and ordered skill names, without
commands or skill bodies. A `cat` or `sed -n` attempt counts only when its path
resolves to a mounted skill or a skill below an installed plugin root verified
by Codex's installation receipt. Missing targets outside a mounted skill
directory, listings, and other harmless mentions of `SKILL.md` do not make the
observation partial. A missing `SKILL.md` target does not count as a read just
because its parent directory belongs to a mounted skill; an existing mounted
target that fails or produces incomplete bytes remains partial. A completed direct
`cat` of one mounted `SKILL.md`, alone or alongside literal documentation
paths, counts only when the command output contains that file's exact body.
Batched reads naming more than 64 paths remain partial, as do failed,
malformed, or incomplete recognized reads. Direct
`sed -n` pages count after their verified line ranges cover the whole body. An
exact `cat` wrapped by `lean-ctx -c` is accepted only when its reported output
still contains the full body; a compressed summary cannot prove the read.
The same exact-body check accepts a literal read followed by one literal `rg`
command, separated by a semicolon or newline. It also accepts a single-file
literal `cat` of the skill followed by one or more literal `cat` reads of
non-skill files, then one literal `rg` command, with the same separators. For
example:

```sh
cat .agents/skills/darrow-guide/SKILL.md; cat docs/specs/repository-guide.md; rg -n -i 'offline|\bsla\b|service.level|guarantee|deployment' --glob '*.md' --glob '!docs/research/**' --glob '!**/SKILL.md' .
```

This sequence uses the shared stream and native read check. Quoted separators
remain part of their literal operand. The ordered file bodies must match the
retained output, so documentation or search output cannot replace an altered
or incomplete skill read. Literal `cat` commands may read multiple mounted
skills and documentation, before or after skills, with or without a terminal
search. Multiple literal terminal `rg` commands are accepted within the command
bound. Each verified skill receives its own ordered receipt. Documentation
must resolve within the workspace or a receipt-bound installed plugin root;
each file is bounded to 1 MiB. Aliases of mounted skills without a literal
`SKILL.md` operand remain unsupported.
The 64-operand bound applies across all reads in the sequence. Shell expansions,
including unquoted glob and tilde operands, are unsupported in this form.

The bounded composed-read grammar also accepts `unset` with literal variable
names, `pwd` or `pwd -P`, `git rev-parse --show-toplevel` (optionally with
`-C "$PWD"`), `printenv` with literal variable names, and `rg --files` with
literal arguments before the reads. Prefix `printenv` requires the reads to
end the command, so environment output cannot replace missing read bytes.
Literal `printenv` commands may follow reads without prefix `printenv`.
The fixed pair `repo=$(git -C "$PWD" rev-parse --show-toplevel)` and
`cd "$repo" && pwd -P` is supported only with absolute read operands. Other
assignments, substitutions, directory changes, or control flow remain
unsupported. Prefix and environment output cannot supply skill frontmatter;
ambiguous repeated output cannot establish an attributable read.

The check also accepts a chain of literal
`cat` fallbacks with `2>/dev/null` and `||`, ending in `true` followed by a newline
and one literal `rg` discovery command. A fallback chain must resolve to one
canonical file across all its read operands; absent alternate targets do not
invalidate the read. Each fallback `cat` names one literal file. Multiple
existing targets, including unmounted copies,
cannot establish an attributable read. The total read operands remain bounded
at 64. The complete command must succeed and expose the mounted file's entire
exact body. `cat` accepts literal file operands and the optional `--` delimiter;
other options cannot prove an unchanged read. Substitutions, pipelines, other shell control flow, and dynamic
search arguments cannot establish a compound read through this check.
Unrecognized commands remain partial when their output contains the identifying
`name: <skill>` line from a mounted or receipt-bound installed-plugin skill.
This is a host observation; an extension decides what selection means for its
case.
The same check accepts skill files below the exact installed plugin roots from
Codex's installation receipts. It does not infer activation from arbitrary
files in the private plugin cache.
The `sevro.codex.native-calls` capability retains allowlisted direct goal and
agent control calls from the native session bound to the completed thread. Its
observation contains only call names, namespaces, and source ordinals, plus the
count of submitted `exec` calls. It also records accepted native subagent
spawns when one request, host start, and matching result occur in order. That
receipt contains bounded agent identity, route fields, and source ordinals;
private task messages, code, and outputs are discarded. An accepted spawn proves
host acceptance, not the child's role, work, or completion. Duplicate,
mismatched, or malformed evidence cannot establish acceptance.
The observation also records the ordered names and namespaces of direct native
tool calls. For collaboration feedback it includes a bounded target when the
target is readable. That list lets an extension evaluate parent activity after
handoff without exposing messages or command input. A partial list cannot
prove that parent work was absent.
The observation also retains bounded feedback call targets and whether one
native tool response was observed for each call. It discards message text and
response content. A response receipt does not establish that the child acted.
For a two-turn case, it classifies native feedback messages as plaintext,
encrypted, or unavailable and records exact equality with the follow-up prompt
only when plaintext is readable. It retains neither message nor prompt bytes.

For a second prompt, `sevro.codex.continuation` retains the last validated
native-session ordinal before resume. Extensions can compare later call
ordinals with that boundary without reading private arguments.
The host also retains separate `sevro.codex.initial-skill-reads` and
`sevro.codex.follow-up-skill-reads` observations. Each applies the same exact
mounted-skill read check to one completed turn, so an extension can grade read
order or a missing repeat read without inferring it from the combined list.
For `app-server`, the verified same-thread feedback boundary separates the
initial phase from the follow-up phase, including subsequent native goal turns.
Absent, duplicated, foreign-thread, or failed boundaries do not yield phase
receipts.

It also checks native parent command records for exact mounted skill bodies,
including sessions with no spawn request. The bounded diagnostic distinguishes
no read from an incomplete read without claiming skill activation.
It retains the skill name and native ordinal when verified reads complete a
whole body. Repeated complete reads produce separate receipts; paged reads
produce one receipt when their ranges first cover the body. An incomplete
later reread makes the diagnostic partial. Extensions can compare these
ordinals with an accepted owner boundary without retaining commands or output.
Earlier yielded output can complete a read only when its process and unique
call identity bind it to that actor's native command completion. Completed
literal command calls use a bounded TypeScript parser; conditional or ambiguous
code cannot establish that binding. Recovery verifies the exact mounted bytes
and recomputes completeness for the matching CLI command. Private commands,
submitted code and recovered skill bodies stay out of public observations.
For accepted spawns, it also checks up to eight child thread rollouts and
reports whether each is available, unavailable, ambiguous, or partial, with an
explicit truncation flag. An available rollout includes bounded diagnostics for
native child commands: the number of commands and skill read attempts, whether
the exact mounted `SKILL.md` body was read, and whether the check was complete
or truncated. A rollout with no read differs from a missing or malformed
rollout. These diagnostics do not establish skill activation or task completion
by themselves and retain no child prompt, command, or output.
An available child rollout also reports whether one nonempty final assistant
message matches a later native completion event for the same turn. This proves
a returned turn, not the accuracy of the child's work, and retains no message
body.
Each available accepted child rollout also retains up to eight nested spawn
requests with an explicit `requestsTruncated` flag. A request records bounded
task name, model, effort, and context-fork fields, whether the host accepted it,
and, for an accepted request, the child reference and thread. The corresponding
reader session is classified as available, unavailable, ambiguous, or partial;
`readerResultStatus` is completed only when a nonempty final answer matches a
later native completion in that session. Private task and answer text are
discarded. Extensions interpret task names and decide whether a nested reader
satisfies their policy.
The record proves an invocation attempt, not its success. A missing, ambiguous,
unreadable, oversized, or malformed session is unavailable or partial, so its
absence cannot prove that a control was unused. Code Mode submissions now have
separate bounded `execCalls` inspection receipts, described in the
[native control contract](native-controls.md). Direct native call ordinals and
acceptance receipts keep their original meaning; submitted requests do not
acquire direct native acceptance receipts.
For an explicitly declared `$plugin:skill`, the host verifies that the installed
skill exists and that the exact token occurs once in the delivered prompt. A
completed turn yields a complete `sevro.codex.explicit-invocation` with the owner
first and verified supporting reads after it. This receipt proves verified
owner dispatch independently of file reads; it does not prove that all
supporting skills were read. Consumers requiring complete supporting-read
evidence must also require `sevro.codex.skill-reads` (or the applicable phase
receipt) to be complete. Failed execution cannot yield a complete dispatch
receipt.
The `sevro.codex.repository-invocation` capability supports an explicitly
declared `$skill` from `.agents/skills/<skill>/SKILL.md`. The host checks that
the repository mount is a bounded regular file with no symlink components and
that the token occurs once across the delivered turns. It uses the same
completed-turn dispatch receipt without wrapping the skill as a plugin.

`createCodexHost` copies file-based authentication into a private Codex home
for each trial. It supplies only explicit environment variables to the parent
process and uses a runner-generated permission profile for candidate commands.
When the extension declares a local Codex marketplace, the host verifies its
manifest contains only the named plugins with local sources, rejects package
symlinks, and installs it with `codex plugin marketplace add` followed by
`codex plugin add`. It checks each installation receipt against the private
plugin cache. Candidate commands can read that cache, while the rest of the
private Codex home, including authentication and configuration, remains denied.
It refuses fixture-local `.codex` configuration, unsupported enforced
conditions, unreadable or oversized auth files, malformed event streams, and
incomplete turns. The host bounds output and runtime, kills its process group
on timeout or cancellation, and removes private state after the turn. It is
available through the engine's injected host interface and the development
CLI's explicit `--host codex` route. Its protocol and evidence host ID is
`sevro.host.codex`; `codex` remains the CLI route selector.

`prepareMacSandboxCommand` and `prepareLinuxSandboxCommand` provide the shell-grading boundary. Callers
provide absolute protected roots and a private state root; the primitive
canonicalizes them, refuses overlap with the fixture workspace, and creates a
temporary native sandbox that denies reads and writes. It fails if
isolation is unavailable. The caller releases the sandbox resources after the
process exits. The runner assembles the same protected-root set for Codex
candidate commands and shell grading.

Codex cannot start its native sandbox inside an outer `sandbox-exec` process
on macOS. Its runner-generated permission profile therefore sets an
explicit workspace rule, denies all other filesystem roots except minimal
runtime files and the selected executable's install directories, and
specifically denies protected roots and the private Codex home. An executable
inside a protected root is rejected. The profile also disables command
network access by default and clears inherited command environment variables.
The runtime [local HTTP option](runtime-v1.md#local-http-test-servers) enables
Codex's managed network proxy and local binding for socket-using tests.
The Codex
parent can read authentication before it starts sandboxed commands. Tests
invoke the installed `codex sandbox` CLI to prove fixture access, denied
source/auth reads, and executable access. The process adapter verifies these
properties in one sandbox invocation before each fresh host request, with a
60-second bounded startup deadline. The combined probe still requires readable
private command storage, denied project listing, denied authentication and
configuration reads, and a successful native executable `--version`. Continuation
turns reuse the same isolated state. The longer deadline accommodates observed
native policy startup; it is not counted as a performance saving.

Native plugin installation remains fresh for every host request. Reusing an
installed home would carry configuration, marketplace registrations, and
absolute installation paths into a different private namespace. Selected hook
wrappers additionally embed that request's runtime, sandbox profile, and receipt
paths. Replaying an old installation receipt cannot establish a new installed
path. Sevro therefore retains native marketplace/plugin installation and receipt
verification, fresh credentials/configuration, hook rewriting, preflight, and
invocation evidence for every request. See the [startup measurements](evidence/runtime-startup-30/README.md)
for measured boundaries, copy-on-write assessment, and limitations.

Native read diagnostics retain at most 64 `recoverySources` entries. Each
records its native ordinal, whether the native completion had output, the
yielded chunk count, and separate `completedCall` and `literalCommandCall`
flags. These facts distinguish recovery sources without retaining commands,
submitted code, or skill bodies. The diagnostic's completeness and truncation
fields still determine whether its read evidence can support grading.

[Issue #70 representative retests](evidence/skill-reads-70/results.json) retain
separate task, activation, and phase-read outcomes from the private candidate,
plus its source fingerprints and test-first regression results. Private native
transcripts remain outside the repository.
