# Codex host integration

The Codex adapter consumes `codex exec --json` as one JSONL turn. The
`summarizeCodexEvents` parser requires one thread start and a completed turn
with a zero process exit before reporting completion. Malformed, ambiguous,
and oversized streams are errors. Missing or invalid final usage remains
incomplete and is never estimated. The last completed `agent_message` before
turn completion supplies the bounded final response; missing text stays
unavailable.
The bounded JSONL stream is retained per trial as the private
`sevro.codex.events` host artifact. Its file URL and digest appear in trial
evidence and are available to extension grading; the stream bytes stay out of
the run JSON.
The host also retains a bounded `sevro.codex.skill-reads` observation. It
records the first verified mounted skill and ordered skill names, without
commands or skill bodies. A completed direct `cat` of a mounted `SKILL.md`
counts only when the command output contains that file's exact body. Direct
`sed -n` pages count after their verified line ranges cover the whole body. An
exact `cat` wrapped by `lean-ctx -c` is accepted only when its reported output
still contains the full body; a compressed summary cannot prove the read. An
attempted indirect, malformed, or incomplete read makes the observation
partial. This is a host observation; an extension decides what selection means
for its case.
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

For a second prompt, `sevro.codex.continuation` retains the last validated
native-session ordinal before resume. Extensions can compare later call
ordinals with that boundary without reading private arguments.

It also checks native parent command records for exact mounted skill bodies,
including sessions with no spawn request. The bounded diagnostic distinguishes
no read from an incomplete read without claiming skill activation.
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
The record proves an invocation attempt, not its success. A missing, ambiguous,
unreadable, oversized, or malformed session is unavailable or partial, so its
absence cannot prove that a control was unused. Calls made through submitted
code are not classified by this first observation.
For an explicitly declared `$plugin:skill`, the host verifies that the installed
skill exists and that the exact token occurs once in the delivered prompt. A
completed turn yields `sevro.codex.explicit-invocation` with the owner first and
verified supporting reads after it. Incomplete reads make that receipt partial.

`createCodexHost` copies file-based authentication into a private Codex home
for one turn. It supplies only explicit environment variables to the parent
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

`prepareMacSandboxCommand` provides the macOS shell-grading boundary. Callers
provide absolute protected roots and a private state root; the primitive
canonicalizes them, refuses overlap with the fixture workspace, and creates a
temporary `sandbox-exec` profile that denies reads and writes. It fails if
macOS isolation is unavailable. The caller releases the profile after the
process exits. The runner assembles the same protected-root set for Codex
candidate commands and shell grading.

Codex cannot start its native sandbox inside an outer `sandbox-exec` process
on this host. Its runner-generated permission profile therefore sets an
explicit workspace rule, denies all other filesystem roots except minimal
runtime files and the selected executable's install directories, and
specifically denies protected roots and the private Codex home. An executable
inside a protected root is rejected. The profile also disables command
network access and clears inherited command environment variables. The Codex
parent can read authentication before it starts sandboxed commands. Tests
invoke the installed `codex sandbox` CLI to prove fixture access, denied
source/auth reads, and executable access. The process adapter verifies these
properties before every turn.
