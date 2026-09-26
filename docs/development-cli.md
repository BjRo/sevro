# Development CLI

The local `sevro run` command connects a resolved JSON case or an explicit
extension to a host route.
It uses the engine's normal grading and evidence path. This remains a
development entrypoint while the Claude adapter, full extension lifecycle,
and production provenance collection are being built.

```sh
bun src/cli.ts run --json \
  --case-file /absolute/path/case.json \
  --adapter-module /absolute/path/host-adapter.ts \
  --project-root /absolute/path/project \
  --results-root /absolute/path/results \
  --runner-build-digest <64-hex-digest> \
  --project-digest <64-hex-digest> \
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
  --runner-build-digest <64-hex-digest> \
  --project-digest <64-hex-digest> \
  --condition passive --trials 1 --threshold 1
```

The Codex route requires file-based authentication and an installed Codex CLI
with permission profiles. It copies auth into a private home for each turn and
verifies the command sandbox before execution. This route currently supports
only passive conditions. `--host` and `--adapter-module` are exclusive. Use
`--protected-root` to add private roots for Codex, including when no shell
checks are selected.

For cases with `sevro.semantic` checks, also pass
`--semantic-adapter-module /absolute/path/semantic-adapter.ts`. This loads an
explicit second `HostAdapter` for grading. The candidate and semantic routes
are recorded separately in evidence and evaluation identity. The semantic
adapter runs after a complete candidate response in its own empty workspace;
missing or malformed semantic verdicts produce a grading error. This
development CLI does not yet expose the bundled Codex adapter as the semantic
route.

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
accepts inline or repository fixtures and additive extension checks. Requested
instrumentation and task verdict policy replacement are not yet supported.

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
files, hooks, and working-tree state are not copied. Fixture setup operations
beyond a clean repository snapshot are not yet supported. Repository submodules
and preparation artifacts targeting `.git/` are refused.

The case file follows the `ResolvedCase`
interface in `src/engine.ts`; this slice accepts inline files or a declared
repository, built-in output and semantic checks, and isolated shell checks. For shell checks, add
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
revision and dirty content; `--runner-build-digest` and `--project-digest`
remain explicit until build and project content digests are collected
automatically.
Use `--run-state-root /absolute/path/state` to keep active records and trial
checkpoints separate from results; it defaults to `--results-root`. Shell
grading and the bundled Codex route protect this state root from candidate
commands.
SIGINT and SIGTERM request cancellation, retain completed trial evidence, and
return exit codes 130 and 143 respectively after interruption is recorded.
