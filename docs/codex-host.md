# Codex host integration

The Codex adapter will consume `codex exec --json` as one JSONL turn. The
`summarizeCodexEvents` parser requires one thread start and a completed turn
with a zero process exit before reporting completion. Malformed, ambiguous,
and oversized streams are errors. Missing or invalid final usage remains
incomplete and is never estimated. This parser does not launch Codex.

The adapter must run inside an outer isolation boundary that hides source
worktrees, peer fixtures, retained evidence, and global host configuration
from the candidate while allowing the explicit fixture workspace. It also
needs a private Codex home and an independently retained final message. Until
those pieces are built, the development CLI only accepts operator-provided
trusted adapters.
