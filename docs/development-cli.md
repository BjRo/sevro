# Development CLI

The `sevro run` command connects a resolved JSON case or an explicit extension
to a host route. The installed CLI and source entrypoint use the same engine
grading, evidence, and extension lifecycle.

`sevro report` reads one or more retained JSON results through the
[versioned report contract](report-v1.md). It emits Markdown by default or
`sevro.report.v1` with `--json`.

Examples assume [Sevro and Bun are on `PATH`](installing.md#make-the-command-available).
For a contributor checkout, use `bun src/cli.ts` in place of `sevro`.

An installed package records its name, version, and a digest of its packaged
runtime and public contract files without reading runner Git metadata. The CLI
derives the project digest from its revision and dirty patch, or from a bounded
content snapshot when the project has no Git revision. Result and run-state
directories are excluded from that snapshot. When running this source checkout
for coordinated development, pass `--runner-checkout-root` with the absolute
path to this checkout. Sevro verifies that it is the code actually running and
records its revision and dirty-patch digest instead of package provenance.
`bun run test:package-install` verifies the packed package from a separate
temporary project without runner Git metadata.

```sh
sevro run --json \
  --case-file /absolute/path/case.json \
  --adapter-module /absolute/path/host-adapter.ts \
  --project-root /absolute/path/project \
  --results-root /absolute/path/results \
  --condition passive --trials 1 --threshold 1
```

The adapter module exports a default `HostAdapter`. It is executable code
chosen by the operator. The runner does not load it from a case file or infer
it from an installed extension. A bundled Codex route is also available:

```sh
sevro run --json \
  --case-file /absolute/path/case.json \
  --host codex --codex-bin /absolute/path/codex \
  --codex-auth-file /absolute/path/auth.json \
  --model <model> --effort medium \
  --project-root /absolute/path/project \
  --results-root /absolute/path/results \
  --condition passive --trials 1 --threshold 1
```

The Codex route requires file-based authentication and an installed Codex CLI
with permission profiles. It copies auth into a private home for each turn and
verifies the command sandbox before execution. This route currently supports
only passive conditions. `--host` and `--adapter-module` are exclusive. Use
`--protected-root` to add private roots for Codex, including when no shell
checks are selected.

### Trial concurrency

`--jobs <positive integer>` bounds simultaneous trials within one case and
defaults to `3`. Use `--jobs 1` for serial execution. Each trial has an isolated
workspace and distinct retained artifacts. Completed trials are checkpointed
before cleanup; public results and checkpoint entries retain trial-number order
even when completion order differs. The effective job limit is retained in
redacted configuration and participates in evaluation identity.

Cancellation stops admission of later trials, reaches all active host calls,
and waits for them to retain their results before finalizing the run. Execution
or grading errors also stop admission while already active trials finish.
Persistence errors drain active trials before the attempt becomes diagnostic;
their completed evidence survives, and a trial whose evidence could not be
persisted keeps its fixture.

Host adapters receive the operating system's canonical absolute workspace path.
This keeps native cwd evidence and path-bound tooling consistent when the
temporary directory has a logical alias, such as macOS `/var` and `/private/var`.

Sevro reserves candidate and semantic workspace roots before execution so each
sandbox denies later peers as well as active ones. Fixture preparation stays
within the job limit. Completed candidate contents are removed after retention;
empty reservations stay until active trials drain, then unused and completed
roots are removed. A cancellation before any admission retains an interrupted
run with no trial evidence and exits `130` or `143` without calling a host.

Completed fixture cleanup restores owner access to permission-locked candidate
directories when necessary, then removes their contents. It keeps empty reserved
roots until active work drains. Permission repair stays in the completed
workspace and never follows symbolic links to external targets. Evidence is
retained before cleanup, including when cleanup itself fails.

### Project and configuration roots

`--project-root` identifies the evaluated project and extension case discovery.
Use optional `--config-root /absolute/path/to/configuration` to import Codex
settings from a separate directory. It defaults to the project root. Sevro
captures only `agents.max_concurrent_threads_per_session` from
`.codex/config.toml` once per invocation and applies it to the candidate,
semantic judge, and advisory reviewer when those roles use Codex. The value
must be a positive TOML integer within JavaScript's safe integer range. Missing
files or an absent setting retain the host default; malformed, unreadable,
oversized, or linked configuration files fail with exit `64` before execution.
Model, permission, hook, credential, and environment settings are not imported.

Retained `configuration.redacted.hostConfiguration` records the effective
namespaced setting separately for each used role. A changed setting changes
evaluation identity. The selected configuration root and its primary and linked
Git worktrees are protected from bundled candidates and isolated shell checks.
The same worktree protection applies to other declared source and private roots;
a package without Git metadata remains usable. Result and active-run storage
stay independent through `--results-root` and `--run-state-root`.

A bundled Claude Code candidate route is available on macOS and Linux:

```sh
sevro run --json \
  --case-file /absolute/path/case.json \
  --host claude --claude-bin /absolute/path/claude \
  --model sonnet --effort medium \
  --project-root /absolute/path/project \
  --results-root /absolute/path/results \
  --condition passive --trials 1 --threshold 1
```

The route reuses existing Claude authentication. An explicit
`--claude-credential-file` takes precedence over inherited credentials. Otherwise,
it forwards `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` when present, leaving
their relative precedence to Claude Code. With neither variable present, it
copies `.credentials.json` from `CLAUDE_CONFIG_DIR` or `~/.claude`, then falls back
to the macOS Keychain if the saved file is absent. An unreadable, empty or
oversized selected file fails rather than falling back to another login.
Only credentials enter private per-turn state; user rules, settings and hooks
remain excluded. The host denies both authentication variables to sandboxed
commands and enables Claude Code's subprocess credential scrubbing. Credential
values are excluded from retained evidence and configuration digests. Pass
`--claude-credential-file` with an absolute path to select a separate saved login.
It accepts declared Claude
plugin directories and explicit skill invocations from extension preparation.
It runs candidate tools under Claude Code's native sandbox with private,
source, and result paths denied. The route disables hooks by default and does not expose
the Write tool. It currently supports passive candidate turns only. Use
`--protected-root` to exclude additional private paths from the candidate's
filesystem access. Configure shared host tools, private caches, goals, and selected
plugin hooks with [`sevro.json` or `--runtime-config-file`](runtime-v1.md).
The same policy reaches isolated checks and native grading hosts.

The deprecated options remain available when no runtime file is selected.
For plugins that run locked UV backends, use
`--claude-uv-cache-dir /absolute/path/to/curated-cache` to copy a prepared UV
cache into the trial's Git-private runtime directory before the turn. Use
`--toolchain-bin-dir /absolute/path/to/bin` for a compatible Python and other
case tools. The host and isolated shell checks place that directory on `PATH`.
They keep UV's project environment and Python bytecode outside the assessed
worktree contents so a check cannot change the candidate fingerprint.
With a curated UV cache, the Claude candidate's isolated `HOME` also lives
under the trial's Git-private runtime directory. Isolated checks use their own
home there. Tools choose their own caches from those homes; Sevro does not
set repository-specific cache variables or inherit such overrides from the
caller. Candidate and check homes are separate, while the curated UV cache is
shared within one trial. Runtime state is removed with the trial fixture.
The cache and toolchain directories must be outside protected roots. Their
contents are available to the candidate, so prepare them from public tools and
dependencies only.
Use `--claude-project-settings` when an isolated fixture intentionally defines
project-local `.claude/skills/`. The host still disables hooks in its explicit
settings and keeps its native sandbox rules. Leave this option off for plugin-only
cases.
Without that option, the host does not advertise
`sevro.claude.repository-invocation` and refuses explicit repository dispatch
before launching Claude. This avoids recording an unknown command as a usable
repository-skill route.
The host reads only bounded Skill metadata from completed child Agent sessions
in its temporary private configuration, then removes those session files. A
missing or inconsistent graph leaves `sevro.claude.nested-skills` partial.

A case's `followUpPrompt` starts a UUID-bound session and resumes that same
session after a complete successful initial result. Both results must name
the requested session. The same isolated workspace, settings, credentials,
model, and effort apply to both calls. An initial failure prevents resumption;
a failed or unbound resumed result fails execution and skips grading.
The `sevro.claude.continuation` observation records the bound session and
whether visible worktree contents changed before feedback, with partial
evidence when the fingerprints are unavailable. It retains no file names,
contents, private launch intent, or message-delivery claim. Combined and
separate turn event artifacts remain bounded and private. The last response
is graded, and only complete per-call usage and cost series are summed.

For cases with `sevro.semantic` checks, also pass
`--semantic-adapter-module /absolute/path/semantic-adapter.ts` to load an
explicit second `HostAdapter` for grading. Alternatively, select the bundled
Codex route with `--semantic-host codex --semantic-model <model>
--semantic-effort <effort>`. That route also requires `--codex-bin` and
`--codex-auth-file`, shared with a Codex candidate route when present. The two
semantic route options are exclusive. The candidate and semantic routes are
recorded separately in evidence and evaluation identity. The semantic adapter
runs after a complete candidate response in its own empty workspace; missing
or malformed semantic verdicts produce a grading error.

For generated Git or repository fixtures, add
`--advisory-adapter-module /absolute/path/advisory-adapter.ts` to request an
independent quality review. Alternatively, use `--advisory-host codex
--advisory-model <model> --advisory-effort <effort>` with the shared Codex binary
and auth file options. Repeat `--advisory-exclude <fixture-relative-path>` for
additional evaluator files to omit from the review view. The reviewer sees the
candidate change in a separate Git workspace, with root `.agents`, `.claude`,
`.codex`, and Git history withheld. Its structured assessment, usage, and raw
response are retained separately; reviewer failure or a failing recommendation
does not change the task verdict.

To resolve one case through a versioned extension, replace `--case-file` in
either command with:

```sh
--extension-command-file /absolute/path/extension-command.json \
--extension-source-file /absolute/path/extension-source.ts \
--case-id example-case
```

The command file is a JSON argv array such as
`["/absolute/path/bun", "/absolute/path/extension-source.ts"]`. Repeat
`--extension-source-file` for the extension's source closure. The runner hashes
those files and the executable, negotiates `sevro.extension.v1`, resolves the
selected case, then calls `prepare` and `evaluate` around host execution.
`--case-file` and `--extension-command-file` are exclusive. This CLI currently
accepts inline, generated Git, or repository fixtures and additive extension checks. An
extension may request a host-declared instrumentation capability during
`prepare`. The host adapter receives the request and must report exactly what
it applied. An execution-changing request is refused for `--condition passive`;
an unsupported or unconfirmed request cannot pass. The bundled Codex route
currently advertises no instrumentation capabilities. Set `executable: true`
on a preparation artifact to install it with owner execute permission; Sevro
retains the flag and mode in evidence. Repeat
`--replace-builtin-grader <sevro.grader-id>` to explicitly replace built-in
graders declared by the selected case. The case must also declare an advertised
extension check. The runner validates the replaced declarations but does not
run them; unselected built-ins stay active. Duplicate or absent grader IDs are
configuration errors.
To select an advertised extension task-verdict policy, pass
`--task-verdict-policy <namespaced-policy-id>` with the extension command. A
completed, fully graded trial uses the policy's recommendation for its task
verdict; failed execution, grading errors, and unavailable required evidence
cannot become a pass. Without this option, the runner uses its default task
verdict and rejects unsolicited recommendations.

If the extension needs configuration, supply both
`--extension-configuration-file` and
`--extension-redacted-configuration-file` as absolute paths to JSON objects.
The latter replaces secret values for the retained configuration digest. Keep
secrets out of the command argv and the redacted file.

An extension may return preparation artifacts that cite source IDs. Declare
those sources with `--case-source-root /absolute/path/sources` and
`--case-source-map-file /absolute/path/map.json` together. The map is a JSON
object from source ID to `file:///` URL. The runner checks that each referenced
file stays under the declared root and matches the extension's digest. The
selected case file, extension inputs, and source root are protected from
candidate execution and isolated shell checks. Each mapped source path is also
protected, including its primary repository and linked Git worktrees even when
those worktrees are outside the source root. Bundled candidates, semantic judges,
advisory reviewers, and isolated shell checks receive these protections.
The same map can declare a repository directory for a case fixture. A direct
case file uses `"fixture": {"sourceRef": "fixture-repo"}`; an extension uses
`{"kind": "repository", "sourceRef": "fixture-repo"}`. The repository must be
clean and committed. Sevro clones that commit for each trial without hardlinks
or remotes, and includes the commit in fixture identity. Uncommitted source
files, hooks, and working-tree state are not copied. Repository fixtures
may declare bounded `files`, `staged`, and `commitFiles` fields. Sevro applies
files after cloning, optionally commits them as scaffolding, then stages named
overlay files. Existing source files may be replaced, but symlinks and `.git/`
paths cannot be overlay targets. Both Git fixture kinds may declare bounded
executable `hooks` and `bin` tools by name. Sevro installs them under `.git/`
after its own fixture commits and before setup or host execution. Setup and
isolated shell checks receive `.git/fixture-bin` on `PATH`. Host adapters
receive `fixtureBinDir` and must add it to their native tool environment; the
bundled Codex adapter also preserves it across login shells. A negotiated
fixture setup command may then prepare the clone before the host runs.
Repository submodules and preparation artifacts targeting `.git/` are refused.

A direct case or extension can declare a generated Git fixture:

```json
{
  "kind": "generated",
  "commits": [
    { "message": "chore: initialize", "files": { "README.md": "base\n" } }
  ],
  "files": { "README.md": "edited\n" },
  "staged": ["README.md"]
}
```

Sevro creates the declared commits with a fixed local identity and date for
every trial, then writes the optional working-tree `files`. `staged` may name
only those overlay files. `commitFiles: true` commits the overlay as scaffolding
before staging. Paths under `.git/`, collisions, invalid staging, and oversized
histories fail preflight. Fixture tool and hook declarations enter the
fixture digest.

The case file follows the `ResolvedCase`
interface in `src/engine.ts`; this slice accepts inline files, generated Git
history, or a declared repository, built-in output, semantic, and Git HEAD
checks, and isolated shell checks. Add `{{sevro.workspace}}` to a case prompt
when the host needs the trial's absolute fixture path. Sevro resolves it after fixture
creation for each trial and retains the template in evaluation identity. For
cases with two participant turns, set `followUpPrompt` to a nonempty second
prompt. Sevro renders the workspace token in both prompts and requires a host
that declares `sevro.host.continuation`. The Codex host resumes the original
thread after a completed first turn and grades the second turn's final message.
Both bounded event streams are retained as separate artifacts.

The Codex host also retains `sevro.codex.continuation`, a bounded observation
of the resumed thread and whether visible workspace contents stayed unchanged
until the second prompt. An unreadable or oversized workspace makes that
comparison partial and its unchanged value null.
It also records the last validated native-session ordinal before the second
prompt. Missing or malformed native session evidence leaves this ordinal null;
the observation retains no prompt, tool arguments, or session content.

For shell checks, add
`--shell-isolation` and repeat `--protected-root /absolute/path` for every
additional source worktree or private root. The engine always protects the
selected project, results, runner source, user home, configured host homes,
and active peer fixtures. Shell checks require macOS `sandbox-exec` or Linux
`bubblewrap`.
Injected host adapters may return namespaced observations and bounded evidence
artifacts. A case can list their IDs in `requiredEvidence`; missing or partial
host evidence produces unavailable grading rather than a passing task. The
runner retains observations and artifact references for extension grading.

`--json` writes exactly one versioned result to stdout, including pre-run
configuration failures. The process exit code follows `docs/results-v1.md`.
Add `--dry` to resolve and prepare a case without running the host or graders.
Its retained trials record `not_run` / `not_requested` / `not_assessed` and exit
successfully when preparation succeeds. Dry and executed runs have different
evaluation identities.
Run evidence and trial files live under `--results-root`. A packaged runner
needs no Git checkout. Source runs also use package provenance by default;
pass `--runner-checkout-root` with the absolute path to the running checkout
to record its Git revision and dirty content. `--runner-build-digest` and
`--project-digest` remain optional explicit overrides for test fixtures and coordinated
development; normal CLI runs derive both values.
Use `--run-state-root /absolute/path/state` to keep active records and trial
checkpoints separate from results; it defaults to `--results-root`. Shell
grading and the bundled Codex route protect this state root from candidate
commands.
SIGINT and SIGTERM request cancellation, retain completed trial evidence, and
return exit codes 130 and 143 respectively after interruption is recorded.

## Native goal trials

Select `--host codex --codex-entrypoint app-server --condition passive` to host
the original participant thread through native goal continuation. The default
entrypoint remains `exec`. Transport selection enters the host configuration
and evaluation identity. The client sends the original prompt once, waits through
native turns, and reads the final response from the completing root turn. Only
an explicit `followUpPrompt` starts another client-requested turn.

The app-server uses the same isolated Codex home, installed plugins, permission
profile and isolation preflight as the exec route. Native goal facts are retained
as `sevro.host.native-goal`; the objective text is excluded. Failed transport
or turns retain partial evidence and cannot pass the task. Token usage remains
unknown for this transport. Its declared feedback boundary retains whether a
goal was observed and its status before user input was delivered.

Claude also advertises `sevro.host.native-goal`. Its observer binds one persisted
transcript to the original successful native session and retains goal status
and objective length. Missing, ambiguous, malformed or oversized evidence is
unavailable; an unavailable observation cannot prove goal absence.

These additions require the `0.1.0-rc.2` candidate. The published `rc.1` lacks
the app-server selector and native goal observations.
