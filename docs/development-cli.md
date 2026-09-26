# Development CLI

The local `sevro run` command connects a resolved JSON case to a host route.
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

The case file follows the `ResolvedCase`
interface in `src/engine.ts`; this slice accepts inline fixture files,
built-in output checks, and isolated shell checks. For shell checks, add
`--shell-isolation` and repeat `--protected-root /absolute/path` for every
additional source worktree or private root. The engine always protects the
selected project, results, runner source, user home, configured host homes,
and active peer fixtures. Shell checks require macOS `sandbox-exec` in this
development slice.

`--json` writes exactly one versioned result to stdout, including pre-run
configuration failures. The process exit code follows `docs/results-v1.md`.
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
