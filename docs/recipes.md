# Run complete evaluation recipes

Copy a recipe, run its positive and negative controls, then select a native
model. The complete projects live in [examples/recipes](../examples/recipes).
They include cases, fixtures, evaluator checks, runtime files, adapters, and a
small extension.

## Prepare a recipe project

Use Bun 1.3.13, Git, Node 24.13.0, and `rg`. Shell checks need macOS
`sandbox-exec` or Ubuntu `bubblewrap`; native Claude also needs `socat` on
Ubuntu. Python/UV and mise add the prerequisites stated below.
[Install Sevro](installing.md), then set the recipe path from the directory
containing its local installation:

```sh
export SEVRO_RECIPES="$PWD/node_modules/@bjoernrochel/sevro/examples/recipes"
```

Run commands below from an otherwise empty working directory to keep generated
outputs together. The launcher uses
the CLI beside its original package; it does not require a global installation.

To adapt a separate copy, preserve the small project's whole directory:

```sh
export SEVRO_RECIPE_CLI="$(cd "$SEVRO_RECIPES/../../src" && pwd)/cli.ts"
cp -R "$SEVRO_RECIPES" ./my-recipes
export SEVRO_RECIPES="$PWD/my-recipes"
```

Each command saves `result.json`, the materialized case or extension command,
and retained evidence under `.sevro-recipes/<recipe>/<route>/<mode>/` in your
current directory. The project snapshot is separate from recipe inputs and
results. Stderr names the exact result path and effective settings; stdout is
one `sevro.cli-result.v1` JSON document. Follow its absolute `evidencePath`.
The launcher supplies explicit source, project, config, runtime, isolation,
condition, trial and threshold options; inspect [run.ts](../examples/recipes/run.ts)
and the saved inputs when adapting a plain CLI invocation. Existing results
remain until you remove their directory.

For every deterministic positive control, expect exit `0`, execution
`completed`, grading `completed`, task `passed`. Each separate `--fail` command
deliberately exits `1` with execution/grading `completed` and task `failed`.
Run negative controls separately when using a shell with `set -e`. A missing
tool is a prerequisite error, not a passing or intentionally failing control.

`candidate.ts` is an explicitly trusted deterministic fixture editor. It changes
the arithmetic implementation for the coding recipe and supplies a fixed answer
for the other controls. It does not simulate native tool permissions: the real
isolated shell graders execute the stated tools and assertions. Native routes
run the actual task with the same fixture and runtime policy.

For any recipe that offers a deterministic control, replace `deterministic`
with `codex` or `claude` to use a real participant. First install/authenticate
the selected [native CLI](native-hosts.md). For Codex, set the model to an
available identifier and supply your private authentication file path:

```sh
export SEVRO_RECIPE_MODEL='replace-with-an-available-Codex-model'
export SEVRO_RECIPE_CODEX_AUTH="${CODEX_HOME:-$HOME/.codex}/auth.json"
bun "$SEVRO_RECIPES/run.ts" coding-change codex --dry
bun "$SEVRO_RECIPES/run.ts" coding-change codex
```

For Claude, use its supported credential route and a Claude model identifier:

```sh
export SEVRO_RECIPE_MODEL='replace-with-an-available-Claude-model'
bun "$SEVRO_RECIPES/run.ts" coding-change claude --dry
bun "$SEVRO_RECIPES/run.ts" coding-change claude
```

Substitute the other recipe name to run its native task. `--dry` prepares and
retains inputs without calling a model; remove it for execution. Add `--fail`
to a live command for its deliberate negative control. Native model outcomes
must be observed; a model can ignore a negative-control instruction. The
semantic recipe additionally requires its judge route described below.

## Fix a coding bug with hidden evaluator checks

Files: [coding-change case](../examples/recipes/cases/coding-change.json),
[typed evaluator test](../examples/recipes/coding-change/check.ts),
[tool configuration](../examples/recipes/runtime/path.json), and
[candidate](../examples/recipes/candidate.ts). Prerequisite: Node on `PATH`.
The fixture contains a broken `math.cjs` and a task README. The task asks the
participant to implement addition. The evaluator checks positive, negative and
zero arguments. Its source stays outside the candidate fixture: the launcher
transpiles the checked TypeScript test and embeds its JavaScript in the
evaluator-owned shell command before execution.

<!-- sevro-example:recipe-coding-change-pass -->

```sh
bun "$SEVRO_RECIPES/run.ts" coding-change deterministic
```

The isolated check first asserts that the original evaluator test is unreadable,
then runs Node against the changed fixture. The passing shell observation
retains the result and stdout digest. The negative control leaves subtraction
in place, so the arithmetic assertion fails:

<!-- sevro-example:recipe-coding-change-fail -->

```sh
bun "$SEVRO_RECIPES/run.ts" coding-change deterministic --fail
```

Use a native route below to evaluate an actual coding agent. Adding a participant
test to the fixture would make it visible; it would not replace this hidden
evaluator-owned check. The launcher selects `--shell-isolation` and protects
the recipe source; declare additional private worktrees through the
[CLI's protected roots](development-cli.md).

## Add host-tool access, one capability at a time

The smallest useful runtime file is
[runtime/empty.json](../examples/recipes/runtime/empty.json):

```json
{ "format": "sevro.runtime.v1" }
```

It selects the existing isolation defaults without importing tools or hooks.
Add only a declared non-secret `PATH` to reuse installed tools:

```json
{
  "format": "sevro.runtime.v1",
  "environment": { "inherit": ["PATH"] }
}
```

Sevro filters credential-related PATH entries, discovers bounded installation
support trees, grants read-only tool access, and keeps private writable home
and temporary directories. It does not grant the full operator home. Runtime
values enter retained evidence; do not put secrets in this file. See
[runtime details](runtime-v1.md#environment-and-host-tools).

### Minimal tool: ripgrep

Files: [host-tools case](../examples/recipes/cases/host-tools.json) and
[PATH runtime](../examples/recipes/runtime/path.json). Prerequisite: standalone `rg` on
`PATH`, installed outside Codex/Claude credential directories (for example,
`brew install ripgrep` on macOS or `apt-get install ripgrep` on Ubuntu).
Sevro deliberately filters a Codex session's injected `~/.codex/.../rg` path;
that embedded executable alone does not satisfy this recipe. The fixture's `app.env` contains `port=3000`; an actual isolated `rg`
process must find exactly that line.

<!-- sevro-example:recipe-host-tools-pass -->

```sh
bun "$SEVRO_RECIPES/run.ts" host-tools deterministic
```

The negative fixture contains port `9000`, so that same search fails:

<!-- sevro-example:recipe-host-tools-fail -->

```sh
bun "$SEVRO_RECIPES/run.ts" host-tools deterministic --fail
```

### Node

Files: [Node case](../examples/recipes/cases/node.json) and the same PATH runtime.
Prerequisite: Node 24 on `PATH`. The fixture contains `app.json`. A real isolated
Node process parses it, asserts the port, and prints `3000`.

<!-- sevro-example:recipe-node-pass -->

```sh
bun "$SEVRO_RECIPES/run.ts" node deterministic
```

The negative fixture sets port `9000`, causing the Node assertion to fail:

<!-- sevro-example:recipe-node-fail -->

```sh
bun "$SEVRO_RECIPES/run.ts" node deterministic --fail
```

### Python with UV

Files: [Python/UV case](../examples/recipes/cases/python-uv.json) and
[UV runtime](../examples/recipes/runtime/python-uv.json). Install `uv` and an
existing Python 3 first; CI uses UV `0.11.21`. Both executables must be on
`PATH`. The launcher selects `python3`; optionally export `RECIPE_PYTHON` to
the absolute existing interpreter you want. Put that interpreter's installation
bin on `PATH` too, so its bounded support installation can be discovered.

This adds a private writable `UV_CACHE_DIR` and disables Python downloads.
`uv run --offline --no-project` runs the selected existing interpreter, with no
dependency resolution or network. Python parses the fixture JSON, asserts its
port and prints `3000`:

<!-- sevro-example:recipe-python-uv-pass -->

```sh
bun "$SEVRO_RECIPES/run.ts" python-uv deterministic
```

The negative fixture changes the port to `9000`; Python raises an assertion:

<!-- sevro-example:recipe-python-uv-fail -->

```sh
bun "$SEVRO_RECIPES/run.ts" python-uv deterministic --fail
```

For real dependencies, prepare a public cache once outside the evaluated project
and declare a [shared cache](runtime-v1.md#reuse-a-shared-dependency-cache), then
use your locked offline install command. Select only the roles using UV; add
`checks` only when the grader needs it. The same directory can serve candidates,
hooks, and UV-based graders across trials and runs without copying the cache.
Use [private seeds](runtime-v1.md#private-writable-state) when isolated dependency
bytes matter more than disk reuse. This dependency-free recipe needs no cache seed.

### An existing mise installation

Files: [mise case](../examples/recipes/cases/mise.json),
[runtime](../examples/recipes/runtime/mise.json), and the selection in
[run-options.ts](../examples/recipes/run-options.ts). Install mise first; CI
uses `2026.3.13`. Prepare its exact tool before evaluation:

```sh
mise install node@24.13.0
mise where node@24.13.0
```

The launcher asks `mise where node@24.13.0`, prepends that installation's `bin`
to the declared PATH, then runs its Node inside isolation. The evaluator checks
the exact Node version and fixture port and prints `3000`. This route executes
the resolved versioned tool; it does not run a mutable mise shim inside the
sandbox or grant mise's whole data directory.

<!-- sevro-example:recipe-mise-pass -->

```sh
bun "$SEVRO_RECIPES/run.ts" mise deterministic
```

The negative fixture changes the port to `9000`, failing the same Node check:

<!-- sevro-example:recipe-mise-fail -->

```sh
bun "$SEVRO_RECIPES/run.ts" mise deterministic --fail
```

An attempted isolated `mise exec` with read-only operator data returned
`Operation not permitted` on macOS. If your shim needs extra discovery or
writable state, resolve the existing installation before launch as above.
Do not solve that failure by granting the operator's whole home.

## Evaluate a repository skill with Codex or Claude

Files: the complete [sample repository](../examples/recipes/repository-skill/README.md),
its [Codex skill](../examples/recipes/repository-skill/.agents/skills/startup-guide/SKILL.md),
its [Claude skill](../examples/recipes/repository-skill/.claude/skills/startup-guide/SKILL.md),
and the [extension](../examples/recipes/extension.ts). The extension builds a
fresh committed Git fixture and mounts the selected skill as a Git-excluded
artifact. The README is participant-visible; checks and extension source stay
outside. Copy these actual skill bodies and their supporting files when
substituting your own skill.

Install the [native host prerequisites](native-hosts.md). Dry preparation needs
the selected CLI on PATH, but no model login or quota. It negotiates repository
invocation, mounts and hashes the actual skill, validates the case and runtime,
and retains the artifacts. Expect exit `0`, execution `not_run`, grading
`not_requested`, task `not_assessed`:

<!-- sevro-example:recipe-repository-skill-codex-dry -->

```sh
bun "$SEVRO_RECIPES/run.ts" repository-skill codex --dry
```

<!-- sevro-example:recipe-repository-skill-claude-dry -->

```sh
bun "$SEVRO_RECIPES/run.ts" repository-skill claude --dry
```

For a real Codex trial, export `SEVRO_RECIPE_MODEL` to an available Codex model
and `SEVRO_RECIPE_CODEX_AUTH` to your private absolute `auth.json` path, then
remove `--dry`. For Claude, export `SEVRO_RECIPE_MODEL` to an available Claude
model and authenticate through one of its documented credential routes, then
remove `--dry`. Credentials stay outside recipe/project inputs and argv.
These calls consume account quota.

```sh
bun "$SEVRO_RECIPES/run.ts" repository-skill codex
bun "$SEVRO_RECIPES/run.ts" repository-skill codex --fail
```

With `SEVRO_RECIPE_MODEL` set for Claude instead:

```sh
bun "$SEVRO_RECIPES/run.ts" repository-skill claude
bun "$SEVRO_RECIPES/run.ts" repository-skill claude --fail
```

The neutral invocation placeholder becomes `$startup-guide` for Codex and
`/startup-guide` at the start of Claude's prompt. Claude uses the required
`--claude-project-settings`; its runtime leaves goals/hooks disabled. Passing
requires answer content (command and port), the prepared-file assertion, and a
complete explicit-invocation receipt. That receipt proves the bounded dispatch,
not general grounding or quality across other questions.

The deliberate failure is the same command without `--dry`, with `--fail`
added. It explicitly requests the wrong response; expected task verdict is
`failed`, exit `1`. An actual model can disregard a negative-control prompt;
inspect its observed answer and receipt if it unexpectedly passes. Dry
`--fail` only validates that negative-control preparation; it does not observe
model failure.

## Add a separate semantic judge

Files: [semantic case](../examples/recipes/cases/semantic.json), candidate
adapter and [protocol judge](../examples/recipes/semantic-judge.ts). The case
asks for the startup explanation and declares a proposition requiring the
command and port. These credential-free controls exercise routing, source
construction, verdict parsing, and retained semantic evidence:

<!-- sevro-example:recipe-semantic-pass -->

```sh
bun "$SEVRO_RECIPES/run.ts" semantic deterministic
```

<!-- sevro-example:recipe-semantic-fail -->

```sh
bun "$SEVRO_RECIPES/run.ts" semantic deterministic --fail
```

The protocol judge derives pass/fail from the actual candidate-response field
using an exact fixture oracle. It is not a model and does not establish
qualitative judgment quality. The negative response gives the wrong command
and port; semantic grading completes with a failing proposition.

For an actual model candidate and judge, set the native variables above and
export `SEVRO_RECIPE_JUDGE_MODEL` to an available Codex judge model:

```sh
bun "$SEVRO_RECIPES/run.ts" semantic codex --dry
bun "$SEVRO_RECIPES/run.ts" semantic codex
```

`semantic claude` selects a Claude candidate with a separate Codex judge;
it needs both CLIs and the Codex auth path. A correct response is expected to
pass; add `--fail` for the deliberately wrong-response task and an expected
failed verdict. Live verdicts remain observations, not guarantees.

This response-only recipe makes one candidate model call and one additional
judge call per completed trial. The judge receives all its propositions in an
empty temporary workspace. Separate document sources can add further calls;
missing candidate output can avoid a judge call. Judge usage and raw structured
verdicts are retained separately. A malformed or incomplete judge response is
a grading error, not a failed proposition or a passing task. Read
[semantic grading](builtin-graders-v1.md) before adapting its oracle.

## Run the complete extension lifecycle

Files: [extension.ts](../examples/recipes/extension.ts),
[methods](../examples/recipes/extension-methods.ts), and
[artifact preparation](../examples/recipes/extension-artifacts.ts). Prerequisites:
Bun, Git and the platform's shell isolation tool. No model is required:

<!-- sevro-example:recipe-lifecycle-pass -->

```sh
bun "$SEVRO_RECIPES/run.ts" lifecycle deterministic
```

`describe` advertises version/capabilities/grader; `resolve` returns the task
and committed fixture; `prepare` supplies hashed Git-excluded `startup.txt`;
the candidate runs; an isolated built-in check reads the mounted bytes; then
`evaluate` checks the complete final-message evidence for port `3000` and cites
that observation. The default task policy combines these checks. Evidence is
saved before cleanup. Every extension method runs in a fresh process, so prior
process globals are not state. Stdout contains only its matching protocol
response; diagnostics belong on stderr.

<!-- sevro-example:recipe-lifecycle-fail -->

```sh
bun "$SEVRO_RECIPES/run.ts" lifecycle deterministic --fail
```

The wrong final answer fails the built-in output assertion and extension check,
while preparation's shell check still passes. The extension cannot turn missing
evidence or a failed exchange into success. Inspect the saved argv command and
source closure, including its skill resources, to adapt it into your own
[trusted extension](extension-protocol-v1.md).

## Pair plugins, goals, and hooks with preparation

Files: the same extension and artifact builder, plus
[goals runtime](../examples/recipes/runtime/goals.json) and
[selected-plugin runtime](../examples/recipes/runtime/plugins.json).
Prerequisites: a native CLI with plugin and native-goal support; use the
[checked host versions](typescript-quality.md#environment-and-ci). The plugin
manifests, skill and SessionStart command hook are all prepared artifacts, not
an undeclared global installation. The Codex package uses a local marketplace;
Claude uses declared plugin directories. The extension explicitly invokes the
prepared `startup:startup-guide` skill.

First add only native goals to the empty runtime and validate preparation:

<!-- sevro-example:recipe-goals-codex-dry -->

```sh
bun "$SEVRO_RECIPES/run.ts" plugins codex --dry --goals-only
```

<!-- sevro-example:recipe-goals-claude-dry -->

```sh
bun "$SEVRO_RECIPES/run.ts" plugins claude --dry --goals-only
```

Then add `hooks.plugins: ["startup"]` so only this prepared plugin's command
handlers are authorized. Codex selects app-server for its native goal route;
Claude uses plugin-only settings, so do not add `--claude-project-settings`:

<!-- sevro-example:recipe-plugins-codex-dry -->

```sh
bun "$SEVRO_RECIPES/run.ts" plugins codex --dry
```

<!-- sevro-example:recipe-plugins-claude-dry -->

```sh
bun "$SEVRO_RECIPES/run.ts" plugins claude --dry
```

All four dry commands expect `not_run`/`not_requested`/`not_assessed`, exit `0`.
They validate preparation and retain its actual hashed files. They do not
install a plugin into a live native host, execute its hook, or observe a goal.
`--goals-only` is deliberately a preparation step; the final recipe's hook
assertion requires the subsequent full policy.

With the native model/credentials configured, remove `--dry` from the full
plugin command. Expect `passed`, exit `0`: the selected SessionStart hook
writes `hook-ran.txt`, an isolated shell assertion reads `hook ran`, and the
skill answer supplies the startup command/port. The hook runs credential-free
with network denied and only the prepared plugin subtree readable.
`hooks.nativeGoal` enables the native goal facility; inspect retained
`sevro.host.native-goal` observations for actual creation/status. Enabling the
facility or passing this startup task alone does not prove goal completion.

```sh
bun "$SEVRO_RECIPES/run.ts" plugins codex
bun "$SEVRO_RECIPES/run.ts" plugins codex --fail
```

Or, with the Claude model/credential route configured:

```sh
bun "$SEVRO_RECIPES/run.ts" plugins claude
bun "$SEVRO_RECIPES/run.ts" plugins claude --fail
```

For a deliberate failure, run that live command with `--fail`; the requested
wrong response should fail the answer checks while the hook assertion passes.
Removing `startup` from the runtime's allowed plugins is a separate diagnostic:
the command hook is filtered and the hook-file assertion fails. Native/model
behavior must be observed before claiming either live outcome.

## What tutorial verification proves

`bun run test:docs-examples` packs this candidate, copies the packaged recipe
project to a fresh consumer directory, and executes every marked deterministic
positive/negative command. It runs real isolated `rg`, Node, UV/Python and
mise-selected Node checks, the hidden arithmetic test, semantic protocol
control, and the entire extension lifecycle. Missing UV, Python, mise or its
declared Node installation fails with an actionable prerequisite error; no
recipe is silently skipped. CI provisions these tools explicitly.

The verifier also dry-prepares every recipe with both native hosts, including
both skill/plugin variants, negative-control inputs and the goals-only step,
and verifies retained artifact digests. These are not authenticated model,
goal, plugin-installation or hook-execution trials. Run the live commands to
measure those routes. The separate published-consumer check executes the
installed-package tutorial using the exact current version and license metadata.
