# Contributing to Sevro

Contributions are welcome: runner fixes, extension examples, tests, documentation,
and useful bug reports. Agent guidance lives in `AGENTS.md` in a source checkout.
The [public contracts](docs/contracts.md) define the behavior compatibility boundary.

## Contribution licensing

By intentionally submitting a contribution for inclusion, you confirm that you
created it or have permission to license it, including employer-owned work.
Identify third-party material and its license separately; do not grant rights
you lack. You make your contribution available under [Sevro's public license](LICENSE).

In addition, you grant Björn Rochel a worldwide, perpetual, non-exclusive,
irrevocable, royalty-free copyright license to use, reproduce, modify, publicly
display, publicly perform, distribute, and license or sublicense the contribution
and its derivatives under other terms, including open-source and commercial
licenses. You retain copyright. This grants permission, not ownership.

Other recipients receive the public terms unless separately licensed. This is
not an Apache-2.0 grant to every recipient. The additional grant lets the
maintainer offer alternatives without obtaining new copyright permission from
each contributor. If you cannot agree, raise that before submitting work for
inclusion. Contributions are provided without warranties to the extent permitted
by applicable law.

## Set up development

Use Bun 1.3.13, Git, Node 24, and npm. Full suite isolation uses `sandbox-exec`
on macOS or `bubblewrap` and `socat` on Ubuntu. Windows acceptance is unverified.
From a fresh checkout:

```sh
bun install --frozen-lockfile
bun run test:docs-examples
```

The second command checks the tutorial in fresh consumer/contributor directories.
Native model trials need their own [credentials and prerequisites](docs/native-hosts.md).

## Quality contract and checks

[The TypeScript quality contract](docs/typescript-quality.md) defines the checked
source inventory, type-aware lint, strict typing, focused functions, reproducible
properties, and independent statement and branch coverage requirements.
Run the complete acceptance command:

```sh
bun run check:typescript
```

It performs frozen installation, schema freshness, formatting, lint, typing,
documentation and guide dry-run checks, tutorial examples, the real Bun suite,
coverage integrity and thresholds, and installed-package validation. Statements
and branches must each reach at least 95% using raw exact counts over the
platform-reachable authored production inventory, including unimported files.
The macOS and Ubuntu gates each measure their reachable host modules; the exact
module and branch-outcome exclusions are recorded in coverage artifacts. The five explicitly
inventoried generated AJV validators are excluded from coverage because this
target measures authored runner behavior; their syntax, schema freshness, typed
boundaries and runtime tests remain checked. Tests and fixtures remain linted and
typed; they do not enter the production coverage denominator. New or changed
source dispositions require review.

Before committing, use `bun run check:typescript --fast` after installing the
locked dependencies. This runs inventory, schema, formatting, lint, typing and
documentation checks; it does not replace full acceptance. CI retains machine-readable coverage
reports under `.quality/` and exposes the stable `TypeScript quality` status.

Run `bun run check:docs:external` separately and [triage network failures](docs/documentation-quality.md#external-links).
Guide changes also need [native evals](docs/guide-evaluation.md).
Documentation checks supplement #1 rather than replacing its contract.

## Delivery and CI ownership

An implementation PR is complete only when required CI checks pass for its exact
published commit. A request to open or update a PR includes monitoring CI and
repairing in-scope failures; it does not authorize merging or unrelated changes.

- Use GitHub CI in `.github/workflows/verify.yml` for full acceptance validation.
  It provides the configured OS, architecture, runtime and native-tool versions,
  non-root user, and isolation prerequisites. Reproducing that environment locally
  with Docker is optional for diagnosis and is not a publication prerequisite.
- After the local pre-commit checks, publish the authorized candidate to its PR
  and require `bun run check:typescript` to succeed in GitHub CI before reporting
  delivery as complete. A local run, fast check, targeted suite, or historical
  result does not establish that the current Ubuntu gate passes.
- Keep the quality bar intact. Repair behavior or add meaningful coverage for
  accepted behavior; do not lower thresholds, exempt authored sources, skip tests,
  bypass checks, or add artificial tests just to move a counter. Remove impossible
  branches by clarifying validated invariants rather than inventing impossible inputs.
- Bind validation to the candidate's exact source and commit. Changes to source,
  tests, tooling, dependencies, schemas, workflows, or guidance invalidate prior
  candidate evidence; require the applicable CI gates on the updated published head.
- After authorized publication, observe required checks for the exact PR head
  until they finish. Queued or running checks, a successful older commit, and a
  passing subset are not completion.
- On failure, inspect the failed job and retained artifacts, reproduce the cause
  locally when useful, repair within the authorized scope, and publish a non-force
  update to the same PR. Continue monitoring without waiting for the user to notice
  the failure or request correction; do not open a duplicate PR or merge it.
- If an external blocker prevents progress, report its concrete evidence and the
  unfinished checks. Keep the PR's status and description honest; do not report
  delivery as complete while required checks remain failing or unobserved.

Release metadata follows `docs/releases.md` and its existing verified-source CI
reuse policy; these implementation gates do not require release test reruns.

## Tests, fixtures, and schemas

Preserve real Bun filesystem/process integration tests and native isolation.
Use deterministic fixtures under `tests/fixtures/`; keep evaluator-only inputs
outside candidate workspaces. Keep credentials and raw trial evidence out of Git.
Add meaningful regression coverage for reproducible bugs. Fixtures should
establish observable behavior, not mirror implementation.

After changing a schema, regenerate its checked-in validators:

```sh
bun run schemas:generate
bun run schemas:check
```

Commit schemas and validators together. Public v1 schemas and extension
capabilities are compatibility boundaries. Document changed meaning, validate
external inputs, and keep missing evidence from becoming a pass.

## Documentation and pull requests

Give each page one reader need: tutorial, how-to, reference, or explanation.
Maintain the [hub](docs/README.md), old destinations, prerequisites, expected
results, and limitations. Preserve historical observations as evidence rather
than rewriting them to describe current behavior.

Use imperative Conventional Commit subjects without trailing periods. Do not
add `Co-authored-by` or AI attribution trailers. Do not change author metadata
without explicit instruction. A PR explains the problem, changed behavior,
compatibility limits, and checks actually performed. Do not claim unexecuted
native trials or remote CI results.

## Maintainer releases

Follow [releases](docs/releases.md): reuse successful source CI, choose a new
version, and submit the release commit through a PR. Release PRs reuse the
existing full quality gate and run static metadata checks; releases do not
rerun local or CI tests. After the PR merges, prepare and inspect the exact
tarball and verify its license, provenance, and checksums before publication.
After changing `package.json.version`, run `bun run docs:sync` to refresh the
[current release](docs/installing.md#current-release). `check:docs`, release
preparation, and package-install validation reject stale release documentation.
Package-install, native, and Darrow compatibility tests belong to development
or an explicitly requested diagnostic, not the release process. Darrow's
dependency update is a separate PR.
Publication, tags, registry changes, and alternative licensing are separate
maintainer actions; preparing a contribution does not authorize them.
