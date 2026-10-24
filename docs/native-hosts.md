# Run native model hosts

The basic tutorial needs none of this setup. Bundled model routes and isolated
shell checks require macOS `sandbox-exec` or Linux `bubblewrap` (and `socat` for
Claude Code), a supported native CLI, and model
authentication. Complete commands/rules live in the [CLI reference](development-cli.md)
and [Codex host reference](codex-host.md).

## Validated platform scope

The full source quality gate has passed on macOS arm64 and Ubuntu 24.04 x64.
Ubuntu evidence includes [the successful source CI run for `cd7542bf`](https://github.com/BjRo/sevro/actions/runs/38692971517).
That run exercises deterministic native-host protocols and real filesystem,
process, network and shell isolation with the pinned prerequisites in
[the quality contract](typescript-quality.md#environment-and-ci). It does not
establish authenticated model success for every host/model combination.
This is prior source evidence; changed candidates still need their own green CI.
Other Linux distributions and Windows are unverified.

On Ubuntu, install `bubblewrap`, `ripgrep`, and `socat`. Unprivileged user
namespaces must work; Ubuntu's AppArmor policy may need a `bwrap` profile.
[CI's setup script](../scripts/setup-ci-linux.sh) supplies and probes the
supported runner setup. Use it as an explicit development setup step where
appropriate; do not assume all Linux hosts have that configuration.

## Codex

Select `--host codex`, absolute `--codex-bin` and `--codex-auth-file` paths,
and the desired model/effort. Sevro prepares an isolated host environment.
Keep authentication private and outside candidate/evaluator-visible inputs.
The default entrypoint is `exec`; app-server selection and native-goal
observations are also available. Unsupported instrumentation is refused.

## Claude Code

Select `--host claude`, an absolute `--claude-bin`, and the desired model/effort.
The route supports passive candidate turns. Explicit `--claude-credential-file`
takes precedence. Otherwise this checkout forwards inherited API/OAuth
credentials, then uses the saved login from the macOS Keychain or saved credential
file. Trials receive only an access token; the parent refreshes a saved login and
writes it back, so evaluations leave your normal Claude login working. See the
[CLI reference](development-cli.md) for refresh and failure behavior.

Repository skill mounts under `.claude/skills` require explicit
`--claude-project-settings`; otherwise repository dispatch is refused before
launch. The bundled route disables hooks by default and omits candidate Write
access. [Runtime configuration](runtime-v1.md) enables native goals and selected
plugin hooks and reuses declared host tools with private or explicitly shared caches.
The CLI reference covers credential scrubbing and follow-ups.

## Skill activation evidence

Both bundled adapters advertise `sevro.host.skill-activations`. Its observation
retains qualified `observedSkills`, bounded call identities, and explicit
`complete` or `partial` collection status. This is the sole activation collector
for each host. It replaces Codex's command-pattern and native output-recovery
detectors and Claude's separate nested-skill collector. Consumers must require
this observation; the retired observation IDs are no longer emitted.

Codex installs passive runner-owned hooks in its private home for each request.
The `tool_result_body_match` method compares returned tool content against a
snapshot of prepared repository, plugin and private user skill bodies. It does
not parse shell commands, so variables, pipelines, Python and nested Code Mode
calls use the same collector. Pre/post call pairs and session start/stop markers
establish collection health. Unselected plugin handlers are removed before
hooks are enabled, and fixture-local Codex configuration remains untrusted.
No global hook installation or root privileges are required.

This Codex receipt proves exact body exposure to the tool caller. Code Mode can
discard that output before returning to the model. An identical ordinary
document also matches; the receipt does not prove its source file was opened.
Identical bodies registered under different names are reported as
`ambiguousSkills`, with partial evidence. Exact pages can establish a body match
across tool results from the same session and turn. Coverage is tied to the
prepared body digest; overlapping or repeated pages cannot fill a missing range.
The call that completes coverage receives the activation receipt. Fragments
from different sessions or turns never combine.

Page matching uses complete nonblank lines as anchors and exact fragments of
at least 32 string code units. Fragments with multiple possible positions in a
body cannot establish coverage. Recognizable unfinished fragments appear in
`partialSkills` and keep the observation partial; a later complete match resolves
them. Within each tool result, text covered by unambiguous complete-body matches
does not also imply partial reads of skills sharing that text. Fragments returned
outside those complete-body spans or in other tool results remain independent
partial-read evidence. Comparison and anchor budgets also fail closed. Private receipts retain
body offsets rather than tool text; the public observation omits those offsets.
Shorter, transformed or unanchored fragments remain outside this matching scope.
Newly created or changed skill bodies are outside the prepared snapshot. A
complete empty observation is limited to this scope and the supported local
tool hook paths.

Codex separates per-skill exposure from collection health in the same
observation. `skillExposures` contains one `{ skill, status }` entry per prepared
catalog entry, in catalog order, with qualified skill names:

| Status      | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `full`      | The complete prepared body was exposed, in one result or exact pages.   |
| `partial`   | Recognizable fragments were exposed without establishing the full body. |
| `none`      | No exposure was detected within a complete collection's matching scope. |
| `unknown`   | No exposure was detected, but collection gaps prevent an absence claim. |
| `ambiguous` | Body exposure could not distinguish identically registered bodies.      |

`collectionStatus` is `complete`, `partial`, or `unavailable`. No parsed hook
receipts means `unavailable`; otherwise collection gaps mean `partial`.
Recognized partial bodies and ambiguous identities alone do not indicate a
collection failure. Their existing `incompleteReasons` still keep the aggregate
activation observation partial for compatibility. Other reason codes, including
truncated call diagnostics, keep collection partial. Older observations without
these new fields have unknown exposure and collection status; do not infer them
from an empty `observedSkills` list.

Exposure statuses use all parsed receipts before the diagnostic `calls` list is
bounded. A proven `full` or `partial` exposure survives collection gaps, including
an earlier pending call, missing lifecycle hooks or an invalid receipt tail.
Full exposure takes precedence over fragments; ambiguous identities cannot
establish exposure of a particular named skill. `none` does not establish that
the skill was never used outside the prepared catalog and matching scope.
Recognizable fragments may be shared by several skill bodies. These statuses
describe content exposure to a tool caller, not instruction compliance, model
visibility or selection order.

The Codex adapter also advertises `sevro.host.skill-exposure-claims`. When at
least one skill has `full` or `partial` exposure, it emits that observation with
`completeness: complete`, `method: tool_result_body_match`,
`scope: positive_exposure`, the original `collectionStatus`, and `skillExposures`
containing only those positive entries. It is absent when no unambiguous
positive exposure is available. Extensions can require this evidence for a
specific positive assertion: accept only `full` for complete body exposure,
or explicitly accept `partial` when recognizable exposure suffices. A `partial`
entry is not a full activation. This receipt cannot establish absence, first
selection, a complete sequence or successful execution; collection remains
independently qualified. Existing activation and primary-selection requirements
are unchanged. Claude's native `Skill` seam does not emit body-exposure statuses
or these positive body-exposure claims.

Codex observations include `incompleteReasons`: an empty array for a complete
aggregate activation observation, or all applicable reason codes for a partial
aggregate observation. The separate `collectionStatus` isolates collection
health from partial bodies and body ambiguity. Older
observations without this field have unknown reasons; their missing details
cannot be reconstructed from balanced native call/return counts.

| Reason                                           | Meaning                                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `host_incomplete`                                | Host execution did not complete.                                                                   |
| `catalog_incomplete`                             | The prepared catalog could not be collected completely.                                            |
| `receipts_unavailable`                           | The receipt file is missing or unreadable.                                                         |
| `invalid_receipts`                               | A malformed receipt stopped processing; earlier valid receipts remain available.                   |
| `receipt_limit`                                  | The receipt file exceeds the collection byte limit.                                                |
| `observer_failure`                               | The hook recorded a failure or writer limit, including input, nesting or matching-budget failures. |
| `session_identity_missing`                       | No root session identity was available.                                                            |
| `session_start_missing` / `session_stop_missing` | The root session lacks the corresponding lifecycle hook.                                           |
| `pending_tool_calls`                             | Pre-tool hooks remain without matching post-tool hooks.                                            |
| `unmatched_post_tool_use`                        | Post-tool hooks were received without pending pre-tool hooks.                                      |
| `duplicate_tool_calls`                           | A pre-tool identity was already pending or finished.                                               |
| `partial_hook_events`                            | A hook receipt is partial independently of body ambiguity.                                         |
| `ambiguous_skill_bodies`                         | Complete body exposure could not distinguish skill names.                                          |
| `partial_skill_bodies`                           | Recognized fragments remain without complete body exposure.                                        |
| `calls_truncated`                                | Relevant call evidence exceeded its public count or byte budget.                                   |

The `collection` summary reports `eventCount`, `preToolUseCount`,
`postToolUseCount`, `pendingToolCallCount`, `unmatchedPostToolUseCount`,
`duplicateToolCallCount` and `partialEventCount`, plus `sessionIdentified`,
`sessionStarted` and `sessionStopped` for the root session. Counts cover all
successfully parsed receipts, including receipts omitted from `calls`; an
unreadable or invalid tail remains unknown. Tool pairing spans the observed
sessions and uses session and tool-use identities. A later balanced pair is
still counted after an earlier anomaly.

`calls` is a bounded selection of complete matches, fragment-only matches,
ambiguous or partial receipts, and receipts associated with pending, orphaned
or duplicate tool identities. Each entry's `fragmentSkills` names recognizable
fragments without exposing their body offsets or digests. A fragment entry can
remain in `calls` after later complete exposure resolves `partialSkills`.
Neither `partial: false` on an individual receipt nor an empty `partialSkills`
array proves aggregate completeness. `truncated` describes this selected call
list, which is never the complete observer event ledger. A pending tool hook
can follow a rejected launch or a missing hook; it does not establish either
cause, and a tool error with a balanced hook pair does not itself imply an
observer gap. These diagnostics preserve unknown activation verdicts and do
not recover activation from native transcripts.

Codex also reports `primarySkill` and `primarySkillCompleteness` separately
from whole-collection completeness. A complete collection establishes its first
observed skill when the first matching receipt credits exactly one skill, or
`null` when none was observed. Multiple bodies credited by the first receipt
leave primary selection unknown even with complete collection; their catalog
order does not prove selection order. A partial collection can still
establish the primary skill when its only gap is pending tool calls, exactly one
skill was credited by the first matching receipt, and every call started through
that receipt has a matching post hook. A later pending call cannot change that
established first selection. An earlier or overlapping pending call leaves the
primary unknown (`null` with `primarySkillCompleteness: partial`). Other
collection gaps remain conservative. Consumers may use the established primary
for first-selection assertions while retaining the partial collection status;
this claim does not establish exclusions or a complete supporting sequence.
When a partial collection establishes the primary, the same collector emits
`sevro.host.skill-activation-claims` as complete evidence with scope
`primary_and_positive_presence`, the qualified `primarySkill`, and `presentSkills`.
It retains `collectionCompleteness: partial`. Consumers cite this receipt for
those specific claims, preserving the protocol's requirement that passing
results cite complete evidence. It cannot establish an exclusion or an
unobserved supporting read and is absent when the primary is unknown.

Claude's `skill_tool_result` method observes its existing structured `Skill`
stream without enabling additional command hooks. It pairs each call with a
successful result under the same session, parent actor and tool-use ID.
Failed calls remain failed; unmatched attempts and malformed or conflicting
records remain partial. Native explicit command expansion can load a skill
without a `Skill` call. Explicit-dispatch receipts describe dispatch only;
they do not add entries to the activation observation. A direct Claude `Read`
also falls outside the `Skill` seam and is not inferred from its file path.

The collectors retain no tool arguments, outputs or skill bodies in the new
observation. Codex catalogs at most 128 skills, each at most 1 MiB, with an
8 MiB total body budget. Call receipts are bounded; missing collection,
unfinished calls, catalog or receipt limits, and failed execution remain
partial. Required evidence must not interpret these states as proof that a
skill was unused.

## Keep sources and credentials separate

Declare source/private roots as documented. Never put credentials in prompts,
argv, redacted configuration, or public evidence. Injected adapters are trusted
code and must implement their execution contract. A synthetic native packaging
fixture proves packaging behavior, not a successful authenticated model trial.
