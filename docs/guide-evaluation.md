# Evaluate the repository guide

Run `bun run eval:guide --host codex --dry` or the corresponding `claude` command
to validate case inventory without launching a model. Live runs use fresh copied
repository fixtures, actual native skill mounts, and existing host authentication.
They retain output/events, source digests, launch versions, and individual checks
under ignored `.guide-results/`. They do not publish results or modify user settings.

```sh
bun run eval:guide --host codex
bun run eval:guide --host claude
```

Use `--case <id>` for a bounded rerun. These commands execute model calls and
consume the selected host account's quota. Results distinguish native selection,
answer checks, and absence of effects; a dry run never proves host support.
The harness checks filesystem changes and tool calls and keeps expected outcomes
out of participant prompts. Exact models, versions, and limits appear in results.

The case matrix covers orientation, explicit invocation, unrelated requests,
missing sources, conflicting identity, stale historical claims, same-session
follow-ups, pressure to edit/install, extension/architecture boundaries,
contributions, and licensing. Fixtures isolate global customizations
where host controls permit; authentication remains private. Security restrictions
remain in place, so absence of effects is evidence within the declared envelope,
not proof that a malicious tool could never escape it.

The [verification record](guide-verification.json) records actual checks and
unverified support. Raw host output stays private/ignored. After guide or source
changes, prior digests are historical until rerun. [Guide contract](specs/repository-guide.md)
defines acceptance. The checkout's inventory at
`.agents/skills/sevro-guide/evals/inventory.json` maps questions to sources and
static destinations; it is not part of the npm package.

Automatic results are evidence signals, not a complete truth judgment. Acceptance
also requires inspecting material claims against the sources actually read.
File listings do not count as source inspection; follow-ups need fresh content.
Claude explicit invocation requires a bound native command and matching mounted
body in its private session receipt. A fallback body read is recorded separately.

After a mechanical checker repair, `--recheck /absolute/path/to/evidence-directory`
reclassifies the retained native events only when host and guide digest still
match. It writes a separate `automatic-recheck.json`, preserves original outputs,
and makes no new model calls. A changed guide body requires new native trials.
Earlier failed outputs remain historical evidence, even when a later rerun passes.
No pre-implementation native baseline was captured for this change; the record
contains forward trials and independent counterexamples, not an invented baseline.
