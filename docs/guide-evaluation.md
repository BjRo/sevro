# Evaluate the repository guide

Guide evals use Sevro's standard CLI, native hosts, built-in answer graders,
and a small extension for guide-specific evidence and fixtures. The inventory and
cases remain under `.agents/skills/sevro-guide/evals/`. The
[extension modules](../scripts/guide/README.md) do not implement a second runner.

From this checkout, validate fixture preparation without launching a model:

```sh
bun run eval:guide --case-id orientation --host codex \
  --codex-bin /bin/false --codex-auth-file /unused-auth.json \
  --model dry-unverified --effort medium --json --dry
```

The dry command's executable and auth paths are unused; it makes no native
host call. The full quality gate dry-prepares every case.

Live runs require the [native host prerequisites](native-hosts.md), macOS
isolation, existing authentication, and an explicit model identifier:

```sh
bun run eval:guide --case-id orientation --host codex \
  --codex-bin "$(command -v codex)" \
  --codex-auth-file "${CODEX_HOME:-$HOME/.codex}/auth.json" \
  --model <codex-model> --effort medium --json

bun run eval:guide --case-id orientation --host claude \
  --claude-bin "$(command -v claude)" --claude-project-settings \
  --model <claude-model> --effort medium --json
```

These commands consume the selected account's model quota. The launcher forwards
[Sevro's CLI options](development-cli.md); use `--case-id` for case selection,
`--trials` for repeated trials, and `--jobs` for Sevro's trial concurrency.
It defaults to one passive trial per selected case. Dry runs retain
`not_run / not_requested / not_assessed`; they never establish native support.

With `--json`, Sevro prints its standard CLI result and evidence path. Ignored
`.guide-results/<run-id>/` directories contain Sevro's `run.json`, trial
evidence and retained native event artifacts. Save stdout to a result file
to use the [standard report command](report-v1.md):

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
fresh follow-up reads cannot pass. Built-in `sevro.regex` checks assess answer
assertions and contradictions. The `sevro.shell` check verifies Git status,
hashes of ignored skill/assets, and visible directories. Custom grading is
limited to selection observations, inspected citations, and attempted effects.
The follow-up case also reuses Sevro's output grader for its initial answer.

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
