# Evaluate the repository guide

Guide evals use Sevro's engine, bundled Codex/Claude hosts, and a repository
extension for guide-specific fixtures and grading. The question inventory and
cases remain under `.agents/skills/sevro-guide/evals/`. The
[extension modules](../scripts/guide/README.md) do not implement a second runner.

From this checkout, validate fixture preparation without launching a model:

```sh
bun run eval:guide --host codex --dry
bun run eval:guide --host claude --dry
```

Live runs require the [native host prerequisites](native-hosts.md), macOS
isolation, existing authentication, and an explicit model identifier:

```sh
bun run eval:guide --host codex --model <codex-model> --effort medium
bun run eval:guide --host claude --model <claude-model> --effort medium
```

These commands consume the selected account's model quota. Use `--case <id>`
for a bounded rerun and `--jobs 1` for serial cases; the default is two concurrent
cases. Each case runs one passive Sevro trial. Dry runs retain
`not_run / not_requested / not_assessed`; they never establish native support.

Each run prints its case states and evidence path. Ignored
`.guide-results/<run-id>/` directories contain Sevro's `run.json`, trial
evidence, retained native event artifacts, and a `result.json` usable with
the [standard report command](report-v1.md):

```sh
bun src/cli.ts report --result-file /absolute/path/to/result.json
```

Sevro owns fixture isolation, native continuation, invocation receipts,
cancellation, retention, and cleanup. Participant fixtures contain repository
documentation and both skill mounts; the eval cases and grader code are withheld.
The case matrix covers orientation, explicit invocation, unrelated requests,
missing/conflicting/stale evidence, follow-ups, pressure for effects,
extension boundaries, contributions, and licensing.
Missing event artifacts, incomplete turns, missing dispatch receipts, or absent
fresh follow-up reads cannot pass. The extension checks guide selection,
answer signals, inspected citations, attempted effects, and unchanged visible
fixture contents.

The execution envelope now follows [Sevro's native hosts](native-hosts.md).
Claude fixtures also deny editing, shell execution, delegation, and web tools.
Codex uses Sevro's standard permission profile, which permits writes inside the
isolated candidate workspace; guide graders reject attempted non-read commands
and changed visible files. This differs from the old guide-only read-only launch.
No-effects results are evidence within those restrictions, not proof that an
arbitrary tool could never escape them.

Automatic checks remain signals, not a complete truth judgment. Acceptance
requires inspecting material claims against the sources actually read.
File listings do not count as source inspection; follow-ups require fresh
content. Explicit invocation requires Sevro's complete host dispatch receipt.
See the [guide contract](specs/repository-guide.md).

The [earlier verification record](guide-verification.json) describes historical
trials of the previous harness. Its outputs and recheck observations are preserved
as history; they do not validate this conversion. The old `--recheck` command
and custom evidence format have been removed. Rerun changed cases through Sevro
and keep prior evidence intact.
The inventory at `.agents/skills/sevro-guide/evals/inventory.json` still maps
questions to sources and static destinations and remains outside the npm package.
No pre-implementation native baseline was captured for the original guide change.
