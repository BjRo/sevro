# Codex host integration

The Codex adapter will consume `codex exec --json` as one JSONL turn. The
`summarizeCodexEvents` parser requires one thread start and a completed turn
with a zero process exit before reporting completion. Malformed, ambiguous,
and oversized streams are errors. Missing or invalid final usage remains
incomplete and is never estimated. The last completed `agent_message` before
turn completion supplies the bounded final response; missing text stays
unavailable. This parser does not launch Codex.

The adapter must hide source worktrees, peer fixtures, retained evidence,
global host configuration, and copied authentication from candidate commands
while allowing the explicit fixture workspace. It needs a private Codex home.
Until the process adapter is built, the development CLI accepts only
operator-provided trusted adapters.

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
runtime files, and specifically denies protected roots and the private Codex
home. It also disables command network access and clears inherited command
environment variables. The Codex parent can read authentication before it
starts sandboxed commands. A test invokes the installed `codex sandbox` CLI
to prove fixture access and denied source/auth reads. The process adapter
must select and verify this profile for every turn.
