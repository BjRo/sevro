# Native control observation v1

The bundled Codex and Claude hosts advertise `sevro.host.native-controls` and
retain an observation with that ID. It exposes host facts for extension policy:

- `method: native_control_calls`;
- ordered `calls` containing only `ordinal`, `namespace`, and `name`;
- `acceptedAgentCount`, a verified Codex acceptance count or `null` on Claude;
- `submittedExecCalls`, the Codex submitted-code count or `null` on Claude; and
- `truncated`, which is `false` for a complete record and may be unknown (`null`)
  for an incomplete Codex record.

The observation's source is the executing host, not the extension. It keeps no
tool arguments, task messages, command bodies, or results. Call labels prove an
invocation attempt, not success. Extensions decide which calls are prohibited.
An unknown acceptance count cannot establish agent acceptance.

Codex projects labels and counts from its bound native-session observation and
preserves its completeness. Incomplete counts remain `null`. Submitted code remains explicit: extensions cannot
infer absence of controls inside code that this observer did not inspect.
Claude records every tool-use label from the bounded stream, with namespace
`claude`, without filtering to Skill or Agent. It requires a completed successful
turn, valid unique tool-use IDs and names, and a non-truncated list of at most
128 calls. Malformed, duplicate, failed, or excessive streams remain partial.
Tool-looking text in arguments or output does not become a native call.

Consumers must verify the source, completeness, shape, ordering, and counts
before using an empty call list to establish absence. Missing or partial
evidence cannot establish a negative assertion.
