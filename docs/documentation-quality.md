# Documentation quality

Every page should answer one reader need: tutorial, how-to, reference, or
explanation. Landing pages can route to multiple modes. Lead with the outcome,
use plain language, and keep commands, prerequisites, limits, and recovery steps.

## Local checks

Run `bun run check:docs`. The Markdown parser checks local targets/anchors,
image alternatives, asset references, fence languages, and exact guide mirrors.
It validates the guide inventory's source/static destinations and case coverage.
It ignores code contents as links and excludes inactive fixture snapshots.
Local checks need no network. Run `bun run test:docs-examples` for the exact
marked tutorial commands in fresh consumer/contributor directories, including
expected verdicts and saved evidence. Candidate commands run against compiled JavaScript. The released-package
check uses the tutorial bundled in that published version; the two results
are reported separately. These commands create and clean temporary directories.
The [recipe verifier](../scripts/documentation-recipes.ts) runs the new packaged
projects separately from the current published version. It executes actual
isolated tool/check positive and negative controls and both native hosts' dry
preparation; authenticated model, plugin-hook and goal behavior remain
unexecuted by that check. Its [prerequisites](recipes.md#prepare-a-recipe-project)
are mandatory, including UV and mise's declared Node installation.

`package.json.version` is the authoritative current version. `bun run docs:sync`
updates only the marked [Current release](installing.md#current-release) section
with its exact npm and Bun installation commands. Keep its markers and heading in place;
the command refuses missing, duplicate, or reversed markers and invalid versions.
The rest of the page stays ordinary Markdown. `check:docs` compares this section
without writing; release preparation and package-install validation also reject
stale output. Run synchronization after a version bump and include the resulting
documentation change. Link installation and update instructions to this section.
Keep historical versions, licensing transitions, and minimum supported versions
fixed and explain their purpose beside each reference.
Link to the current-release section instead of repeating the current Sevro
version elsewhere. Describe features for the latest version, using the installed
`sevro` command in user workflows. Keep source-checkout instructions in contributor
guidance and omit notes about feature unavailability in older releases.

## External links

Run `bun run check:docs:external` separately. Transient failures are retried
twice. The report names the referring page and URL. Fix permanent missing
destinations; triage authentication walls, rate limits, timeouts, and bot blocks
as network limits and retry later. Do not change a valid destination just to
make a network job green. External success does not establish a claim's truth.

## Human review

- Can a new user reach installation, first success, results, troubleshooting,
  architecture, and contributing without the guide?
- Are supported environments, credentials, side effects, and prerequisites
  explicit beside the relevant commands?
- Do descriptive links, meaningful headings, source order, readable tables,
  image alternatives, and words rather than color support accessibility?
- Are current contracts, accepted choices, research, and past evidence distinct?
- Are unique knowledge and existing destinations preserved?
- Do source citations support material guide claims? Are unknowns/conflicts visible?

Guide changes need [native evals](guide-evaluation.md). A structural check is
not proof of selection or a substitute for human review. #1's
[TypeScript quality contract](https://github.com/BjRo/sevro/issues/1) owns code standards.
