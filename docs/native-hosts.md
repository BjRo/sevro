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
observations require `rc.2` or later. Unsupported instrumentation is refused.

## Claude Code

Select `--host claude`, an absolute `--claude-bin`, and the desired model/effort.
The route supports passive candidate turns. Explicit `--claude-credential-file`
takes precedence. Otherwise this checkout forwards inherited API/OAuth
credentials, then tries a saved credential file and macOS Keychain.
These improvements require `rc.3` or later; check the exact installed
release before relying on them.

Repository skill mounts under `.claude/skills` require explicit
`--claude-project-settings`; otherwise repository dispatch is refused before
launch. The bundled route disables hooks by default and omits candidate Write
access. [Runtime configuration](runtime-v1.md) enables native goals and selected
plugin hooks and reuses declared host tools with private or explicitly shared caches. These changes
require `rc.3` or later. The CLI reference covers credential scrubbing
and follow-ups.

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
them. Comparison and anchor budgets also fail closed. Private receipts retain
body offsets rather than tool text; the public observation omits those offsets.
Shorter, transformed or unanchored fragments remain outside this matching scope.
Newly created or changed skill bodies are outside the prepared snapshot. A
complete empty observation is limited to this scope and the supported local
tool hook paths.

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
