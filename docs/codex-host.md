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
