# Development CLI

The local `sevro run` command connects a resolved JSON case or an explicit
extension to a host route.
It uses the engine's normal grading and evidence path. This remains a
development entrypoint while the Claude adapter, full extension lifecycle,
and production provenance collection are being built.

`sevro report` reads one or more retained JSON results through the
[versioned report contract](report-v1.md). It emits Markdown by default or
`sevro.report.v1` with `--json`.

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
bun src/cli.ts run --json \
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
bun src/cli.ts run --json \
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
candidate execution and isolated shell checks.
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
history, or a declared repository, built-in output and semantic checks, and
isolated shell checks. Add `{{sevro.workspace}}` to a case prompt when the host
needs the trial's absolute fixture path. Sevro resolves it after fixture
creation for each trial and retains the template in evaluation identity. For
cases with two participant turns, set `followUpPrompt` to a nonempty second
prompt. Sevro renders the workspace token in both prompts and requires a host
that declares `sevro.host.continuation`. The Codex host resumes the original
thread after a completed first turn and grades the second turn's final message.
Both bounded event streams are retained as separate artifacts.
For shell checks, add
`--shell-isolation` and repeat `--protected-root /absolute/path` for every
additional source worktree or private root. The engine always protects the
selected project, results, runner source, user home, configured host homes,
and active peer fixtures. Shell checks require macOS `sandbox-exec` in this
development slice.
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
needs no Git checkout. This private development checkout records its Git
revision and dirty content. `--runner-build-digest` and `--project-digest`
remain optional explicit overrides for test fixtures and coordinated
development; normal CLI runs derive both values.
Use `--run-state-root /absolute/path/state` to keep active records and trial
checkpoints separate from results; it defaults to `--results-root`. Shell
grading and the bundled Codex route protect this state root from candidate
commands.
SIGINT and SIGTERM request cancellation, retain completed trial evidence, and
return exit codes 130 and 143 respectively after interruption is recorded.
