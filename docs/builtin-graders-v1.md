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

Shell checks, semantic-output checks, and advisory quality judgments still
need their isolation and host routing implementations. They are part of the
target runner contract, not supported by this output-grader module yet.
