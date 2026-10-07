# Your first evaluation

Run a deterministic case and inspect its evidence. You need Bun 1.3.13; no
Darrow checkout, Codex/Claude login, or model credentials are required. The
adapter returns `ready`; Sevro grades that response against `^ready$`.
This teaches the runner lifecycle, not the quality of an actual model.

## From an installed package

Install the published release in a new directory:

```sh
mkdir sevro-demo
cd sevro-demo
bun init -y
bun add --exact @bjoernrochel/sevro@0.1.0-rc.2
```

Published `rc.2` retains its original BSL license and lacks this checkout's new
guide/docs. Read [version differences](installing.md#published-package-and-checkout).

<!-- sevro-example:consumer -->

```sh
mkdir -p project
bun node_modules/.bin/sevro run --json \
  --case-file "$PWD/node_modules/@bjoernrochel/sevro/examples/basic/graded.json" \
  --adapter-module "$PWD/node_modules/@bjoernrochel/sevro/examples/basic/host.ts" \
  --project-root "$PWD/project" --results-root "$PWD/sevro-results" \
  --condition passive --trials 1 --threshold 1 > sevro-result.json
```

## From a contributor checkout

From a fresh Sevro checkout, install locked dependencies:

```sh
bun install --frozen-lockfile
```

<!-- sevro-example:contributor -->

```sh
mkdir -p project
bun src/cli.ts run --json \
  --case-file "$PWD/examples/basic/graded.json" \
  --adapter-module "$PWD/examples/basic/host.ts" \
  --project-root "$PWD/project" --results-root "$PWD/sevro-results" \
  --condition passive --trials 1 --threshold 1 > sevro-result.json
```

## Inspect success and evidence

The evaluated project is separate from the installation. Package dependencies
can contain symbolic links that Sevro refuses when snapshotting a project.

Both commands exit `0`. The result contains this excerpt:

```json
{
  "execution": { "status": "completed" },
  "grading": { "status": "completed" },
  "task": { "verdict": "passed" }
}
```

Inspect `sevro-result.json`; its `evidencePath` names the retained run JSON
inside `sevro-results`. Trial evidence survives fixture cleanup. Use that path
instead of assuming a generated run ID or subdirectory name.

Replace `graded.json` with `prompt-only.json` for a second run. Execution
completes, grading is `not_requested`, and the task is `not_assessed`. Exit `0`
alone does not mean a benchmark passed.

Continue with [reading results](reading-results.md), [creating a case](creating-cases.md),
or [troubleshooting](troubleshooting.md). Maintainers verify the exact marked
commands with `bun run test:docs-examples`; see [documentation quality](documentation-quality.md).
