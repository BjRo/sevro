# Built-in output graders v1

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
optional expected exit code, and timeout. On macOS it executes through the
outer sandbox with network access denied, a credential-free environment, and
caller-declared protected roots. Only the exit code is returned; stdout and
stderr are discarded. It is not connected to the engine's check assessment
yet. Semantic-output checks and advisory quality judgments still need host
routing implementations.
