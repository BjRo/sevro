# Codex host integration

The Codex adapter will consume `codex exec --json` as one JSONL turn. The
`summarizeCodexEvents` parser requires one thread start and a completed turn
with a zero process exit before reporting completion. Malformed, ambiguous,
and oversized streams are errors. Missing or invalid final usage remains
incomplete and is never estimated. The last completed `agent_message` before
turn completion supplies the bounded final response; missing text stays
unavailable. This parser does not launch Codex.

The adapter must run inside an outer isolation boundary that hides source
worktrees, peer fixtures, retained evidence, and global host configuration
from the candidate while allowing the explicit fixture workspace. It also
needs a private Codex home. Until
those pieces are built, the development CLI only accepts operator-provided
trusted adapters.

`prepareMacSandboxCommand` provides the macOS boundary primitive. Callers
provide absolute protected roots and a private state root; the primitive
canonicalizes them, refuses overlap with the fixture workspace, and creates a
temporary `sandbox-exec` profile that denies reads and writes. It fails if
macOS isolation is unavailable. The caller releases the profile after the
process exits. A host adapter must assemble the complete protected-root set;
using the primitive alone does not establish complete trial isolation.
