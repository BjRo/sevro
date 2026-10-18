# Native control observation v1

The bundled Codex and Claude hosts advertise `sevro.host.native-controls` and
retain an observation with that ID. It exposes host facts for extension policy:

- `method: native_control_calls`;
- ordered `calls` containing only `ordinal`, `namespace`, and `name`;
- `acceptedAgentCount`, a verified direct native Codex acceptance count when
  overall coverage is complete, otherwise `null` (also `null` on Claude);
- `submittedExecCalls`, the Codex submitted-code count or `null` on Claude; and
- `truncated`, which is `false` for a complete record and may be unknown (`null`)
  for an incomplete Codex record.

The observation's source is the executing host, not the extension. It keeps no
tool arguments, task messages, command bodies, or results. Call labels prove an
invocation attempt, not success. Extensions decide which calls are prohibited.
An unknown acceptance count cannot establish agent acceptance.

Codex projects labels and counts from its bound native-session observation.
It additionally retains `directAcceptedAgentCount`, the number of positively
correlated direct native spawn acceptances in that source, independently of exec
inspection. This is an observed count, not a total across unknown launch paths.
`coverage.nativeCalls` records native-session completeness;
`coverage.execInspection` records whether all submitted exec sources were
understood and matched to the direct submission inventory;
`coverage.acceptedAgents: direct_native_calls` names the scope of both acceptance
counts. Accepted launches through exec are not included in these direct counts.
When native capture is incomplete, even a zero observed count cannot establish
absence. Native labels remain usable as positive attempt evidence regardless
of an unrelated exec inspection gap. A rejected attempt is never an acceptance.

When submitted code is present, both observations also retain `execCalls`:
one receipt per native `exec` submission, with its native `ordinal`, inspection
`completeness`, and ordered `calls` containing `index`, `namespace`, and `name`.
The index is local to that submission; native ordinals are not synthesized.
The original direct-call list and total `submittedExecCalls` stay unchanged.

Sevro statically inspects bounded straight-line Code Mode
programs without executing them. It accepts literal tool calls, constant result
bindings, template interpolation and `+` composition of inspected expressions,
direct `text`/`store` output, and literal `Promise.all`/`allSettled` batches.
Batch results may use flat constant array bindings or result-only
`forEach(text)` or `for ... of` output, including blocks and conditional
result-field selection. `JSON.stringify`, `String`, object spread/shorthand,
and nested result fields are supported. Numeric output loops must use the
bounded shape `for (let i = 0; i < results.length; i++)`, indexing the known
batch with that loop variable. Output loops and conditional expressions cannot
invoke tools. Destructuring defaults, rest elements,
holes, nested bindings, duplicate names, and shadowed globals remain unsupported.
Tool argument strings, comments and printed tool-looking text
do not become call labels. A rejected tool request returned by a completed
script still appears in its submitted-call inventory. This inventory proves
submission of those requests, not successful effects or acceptance; the existing
acceptance count describes independently correlated direct native spawns.

Dynamic lookup, aliases, shadowed globals, callbacks that invoke tools,
conditional tool execution, and nested executors keep source inspection partial.
Each receipt's `inspectionReason` is `null` on success, or `unsupported_source`,
`malformed_source`, `source_limit`, or `foreign_namespace`. Unsupported syntax
and expression/call-budget exhaustion use `unsupported_source`.
Source is bounded at
64 KiB, traversed expressions at 2,048, and calls at 128 per submission; tool
labels are bounded at 64 characters. Private source and output bytes are discarded.
The portable observation becomes partial if any submission is uninspected or
receipt counts/ordinals disagree with the native list. `acceptedAgentCount`
remains `null` in that case, while native coverage, direct acceptance facts and
the native `submittedExecCalls` count remain independently available.
`submittedExecCalls` and `truncated` depend on native capture, not exec output.

Receipt `completeness` describes source inspection, independently of execution
or displayed output. `execution` is `completed`, `failed`, or `incomplete`;
`output` is `complete`, `truncated`, or `unavailable`. Output evidence requires
a unique later output bound to the same native call ID, with recognized text
blocks. `complete` describes the displayed receipt, not the whole program's
execution. Execution status additionally requires a successful or failed script
header. Missing, ambiguous or
malformed output yields `incomplete`/`unavailable`; a yielded or unrecognized
header stays `incomplete`. Displayed truncation does not change source coverage.
A fully inspected source with no launch call proves that absence even if its
shell output was truncated or the exec cell failed. Source inspection cannot
prove execution or success. Missing fields in historical receipts are unknown;
historical artifacts retain their original results and meanings.

Claude records every tool-use label from the bounded stream, with namespace
`claude`, without filtering to Skill or Agent. It requires a completed successful
turn, valid unique tool-use IDs and names, and a non-truncated list of at most
128 calls. Malformed, duplicate, failed, or excessive streams remain partial.
Tool-looking text in arguments or output does not become a native call.

Consumers must verify the source, completeness, shape, ordering, and counts
before using an empty call list to establish absence. Missing or partial
source coverage cannot establish a negative assertion. For Codex, consumers must
inspect every `execCalls` receipt in addition to the direct `calls` list,
validate receipt ordinals against the direct `exec` submissions, and require
all receipts to be complete with counts matching `submittedExecCalls`.
They can use positively observed native attempt labels before requiring complete
coverage for an absence pass. They must examine submitted labels for prohibited controls even when
`acceptedAgentCount` is zero. Older consumers that require
`submittedExecCalls === 0` remain conservative but cannot use this new evidence
until they adopt receipt validation.

[Regression and retained-trace reinspection evidence](evidence/native-control-coverage-103.md)
records the test-first repair without changing historical trial results.
