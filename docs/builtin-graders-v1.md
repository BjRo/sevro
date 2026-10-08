# Built-in graders v1

Built-in graders assess candidate output, shell-check results, and Git fixture
state. The engine compiles evaluator-owned check declarations before host
execution. A missing or incomplete observation yields `unavailable` for every
output check; it never passes. A failed assertion yields `failed` while grading
itself remains `completed`.

Each declaration has `{ "id", "grader", "configuration" }`. The supported
built-in graders are:

| Grader           | Configuration                                                                 | Assessment                                                                                                |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `sevro.regex`    | `pattern` string; optional `negate` boolean and `flags` string                | Tests final-message text with multiline matching.                                                         |
| `sevro.json`     | Optional RFC 6901 `pointer`, `equals`, `contains`, `exactDocument`            | Parses JSON, then checks selected value or an array member.                                               |
| `sevro.schema`   | Inline `schema` object; optional `exactDocument`                              | Validates the parsed JSON with JSON Schema Draft 2020-12.                                                 |
| `sevro.output`   | Optional text, JSON, and schema assertions in one declaration                 | Retains one outcome for a combined final-message contract.                                                |
| `sevro.shell`    | `run` string; optional `expectedExitCode`, `timeoutMs`, and stdout assertions | Checks exit code and optional stdout assertions in an isolated shell.                                     |
| `sevro.git-head` | `kind`: `"changed"`, `"unchanged"`, or `"base-ancestor"`                      | Compares fixture HEAD and ancestry with the captured base revision.                                       |
| `sevro.semantic` | `proposition` string; optional `artifactPath`                                 | Judges a proposition against the final response or saved document through a separate semantic host route. |

JSON may be raw or contained in one `json` code fence. `exactDocument` requires
the whole trimmed message to be that JSON document or fence. `contains` selects
an array and compares one member against a recursive subset; an object with
only `$regex` matches a string value. Invalid patterns, pointers, and schemas
fail preflight. Schema references are resolved only from the inline schema; the
grader does not read paths supplied by a candidate.

`sevro.output` accepts `expectExact`, `expectRegex`, `notRegex`, and regex
`flags`; `validJson`; an inline `schema`; and `jsonPath` with optional
`expectJson` or `containsJson`. It checks them in that order: JSON validity,
schema, selected JSON value, exact text, positive regex, then negative regex.
`validJson: true` requires the entire trimmed message to be one JSON document
or fence. Exact text compares the untrimmed final message. A bad declaration
fails before host execution.

The shell-check process runner accepts a bounded evaluator-owned `run` string,
optional `expectedExitCode` and `timeoutMs`, plus `expectExact`, `expectRegex`,
`notRegex`, and regex `flags` for stdout. Exact matching removes one final
newline; regex matching always uses multiline mode. The runner executes with
`sh -e`. On macOS and Linux it runs through the outer sandbox with network access denied,
a credential-free environment, and caller-declared protected roots. Without a
stdout assertion, process output is discarded. With one, the runner captures
at most 1 MiB in memory and retains only its digest and byte length. Oversized
or invalid UTF-8 output is a grading error.

The engine grades `sevro.shell` checks after a completed host turn and retains
one bounded observation per check. A mismatched exit code or stdout assertion
fails the task; an isolation, timeout, or process error makes grading
an error. Callers must supply `shellIsolation.protectedRoots` for any shell
check. The engine also protects its package source, project, results, user
home, configured host homes, and active peer fixtures. The caller's list must
include any other source worktrees or private roots. A peer path already
canonicalized by the engine remains in the deny profile if that peer is
removed before the sandbox starts; unverified missing roots still fail.

`sevro.git-head` accepts `kind: "changed"`, `"unchanged"`, or
`"base-ancestor"` for a generated or repository Git fixture. The engine
captures the fixture's base HEAD before the candidate turn, then compares the
current HEAD and ancestry after a completed turn. The base stays in runner
memory, outside candidate control. An invalid declaration or non-Git fixture
fails preflight. An unreadable or malformed Git state is a grading error. A
bounded `sevro.observation.git-head` records the base, current revision, and
ancestry result; checks reference that observation.

`sevro.semantic` accepts a single nonempty `proposition` string (at most 8 KiB)
per check. The operator supplies a separate semantic host route. After a
complete candidate response, the engine sends the bounded final message and
all declared propositions to that route in an empty, temporary workspace. It
requires exactly one `pass` or `fail` verdict with a reason for every declared
check ID. A failed proposition fails the task. A missing or incomplete candidate
message makes semantic checks unavailable without calling the semantic host; a
failed, incomplete, or malformed semantic response makes grading an error.

The engine retains the raw semantic response outside the candidate workspace
as `sevro.semantic.verdicts`, plus per-check observations and any bounded
artifacts returned by the semantic route. The route identity enters the
evaluation identity and run evidence. Semantic host usage is retained
separately from candidate usage. Advisory quality judgments still need a host
routing implementation.

An optional `artifactPath` selects a saved fixture document instead of the final
response. It must be relative to the fixture, exclude `.git` and parent traversal,
and contain at most one `*` in the basename. Exactly one regular file of at most
64 KiB must match; a missing, ambiguous, escaping or oversized artifact makes
grading an error. Checks are grouped by source, so response and document checks
remain independent in the same trial. Artifact outcomes retain the resolved
path and content digest. The semantic host uses an empty workspace and receives
the document as untrusted data.
