# Development CLI

The local `sevro run` command connects a resolved JSON case to a trusted host
adapter module. It uses the engine's normal grading and evidence path. This is
a development entrypoint while Sevro's bundled Codex and Claude adapters,
extension lifecycle, and production provenance collection are being built.

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
it from an installed extension. The case file follows the `ResolvedCase`
interface in `src/engine.ts`; this slice accepts inline fixture files and
built-in output checks only.

`--json` writes exactly one versioned result to stdout, including pre-run
configuration failures. The process exit code follows `docs/results-v1.md`.
Run evidence and trial files live under `--results-root`; no runner Git
checkout is required. The digest arguments are explicit until package and
project provenance are collected automatically.
