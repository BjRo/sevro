# Built-in graders v1

The first built-in graders inspect a complete, bounded final-message
observation. The engine compiles evaluator-owned check declarations before host
execution. A missing or incomplete observation yields `unavailable` for every
output check; it never passes. A failed assertion yields `failed` while grading
itself remains `completed`.

Each declaration has `{ "id", "grader", "configuration" }`. The supported
output graders are:

| Grader         | Configuration                                                      | Assessment                                                  |
| -------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `sevro.regex`  | `pattern` string; optional `negate` boolean and `flags` string     | Tests final-message text with multiline matching.           |
| `sevro.json`   | Optional RFC 6901 `pointer`, `equals`, `contains`, `exactDocument` | Parses JSON, then checks selected value or an array member. |
| `sevro.schema` | Inline `schema` object; optional `exactDocument`                   | Validates the parsed JSON with JSON Schema Draft 2020-12.   |

JSON may be raw or contained in one `json` code fence. `exactDocument` requires
the whole trimmed message to be that JSON document or fence. `contains` selects
an array and compares one member against a recursive subset; an object with
only `$regex` matches a string value. Invalid patterns, pointers, and schemas
fail preflight. Schema references are resolved only from the inline schema; the
grader does not read paths supplied by a candidate.

The shell-check process runner accepts a bounded evaluator-owned `run` string,
optional `expectedExitCode` and `timeoutMs`, plus `expectExact`, `expectRegex`,
`notRegex`, and regex `flags` for stdout. Exact matching removes one final
newline; regex matching always uses multiline mode. The runner executes with
`sh -e`. On macOS it runs through the outer sandbox with network access denied,
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
