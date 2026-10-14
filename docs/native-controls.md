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

Codex projects labels and counts from its bound native-session observation.
When submitted code is present, both observations also retain `execCalls`:
one receipt per native `exec` submission, with its native `ordinal`, inspection
`completeness`, and ordered `calls` containing `index`, `namespace`, and `name`.
The index is local to that submission; native ordinals are not synthesized.
The original direct-call list and total `submittedExecCalls` stay unchanged.

The current source checkout statically inspects bounded straight-line Code Mode
programs without executing them. It accepts literal tool calls, constant result
bindings, direct `text`/`store` output, and literal `Promise.all`/`allSettled`
batches with result-only `forEach(text)` or `for ... of` output. It requires one
unique, later native completion for the same call ID with an intact successful
script envelope. Tool argument strings, comments and printed tool-looking text
do not become call labels. A rejected tool request returned by a completed
script still appears in its submitted-call inventory. This inventory proves
submission of those requests, not successful effects or acceptance; the existing
acceptance count describes independently correlated direct native spawns.

Dynamic lookup, aliases, shadowed globals, callbacks that invoke tools,
conditional code, nested executors, malformed or truncated results, duplicate
receipts, and missing completion keep inspection partial. Source is bounded at
64 KiB, traversed expressions at 2,048, and calls at 128 per submission; tool
labels are bounded at 64 characters. Private source and output bytes are discarded.
The portable observation becomes partial if any submission is uninspected or
receipt counts/ordinals disagree with the native list. Incomplete counts remain
`null`. Native-session completeness still describes session capture separately
from each submission's inspection completeness.

Claude records every tool-use label from the bounded stream, with namespace
`claude`, without filtering to Skill or Agent. It requires a completed successful
turn, valid unique tool-use IDs and names, and a non-truncated list of at most
128 calls. Malformed, duplicate, failed, or excessive streams remain partial.
Tool-looking text in arguments or output does not become a native call.

Consumers must verify the source, completeness, shape, ordering, and counts
before using an empty call list to establish absence. Missing or partial
evidence cannot establish a negative assertion. For Codex, consumers must
inspect every `execCalls` receipt in addition to the direct `calls` list,
validate receipt ordinals against the direct `exec` submissions, and require
all receipts to be complete with counts matching `submittedExecCalls`.
They must examine submitted labels for prohibited controls even when
`acceptedAgentCount` is zero. Older consumers that require
`submittedExecCalls === 0` remain conservative but cannot use this new evidence
until they adopt receipt validation.
