# Releases

Sevro releases are public npm packages named `@bjoernrochel/sevro`. The public
command remains `sevro`, and npm archives use `bjoernrochel-sevro-<version>.tgz`.
A release version is an
exact semantic version; development versions containing `-dev` are not release
candidates. Darrow pins the published version in development dependencies and
its lockfile. Marketplace plugins do not depend on Sevro.

The [current release](installing.md#current-release) uses the current [licensing terms](licensing.md).
Published `rc.1` and `rc.2` retain their original BSL grants. Always select a new
version for publication; a local development tarball does not replace an
already published artifact.

## Candidate contract

Prepare one candidate from the intended release tag and package metadata. The
tag must equal `v<package version>`. Package metadata must identify the public
repository, registry, distribution tag, and an owner-selected license with its
nonempty `LICENSE` file. `latest` identifies the recommended default release,
including a release candidate. Use `next` for a preview that should require an
explicit opt-in. Preparation accepts either tag for prerelease and stable versions.

Preparation creates a new absolute output directory and never replaces an
existing directory. It packs with lifecycle scripts disabled, retains the npm
file inventory, and writes `release.json` and `SHA256SUMS` beside the tarball.
The record identifies the package, version, release tag, distribution tag,
tarball SHA-256 and npm SHA-512 integrity, and the preparation runtimes.
Preparation does not publish a package or create a Git tag.

For development or explicitly requested diagnostics, the package installation
check accepts `--tarball <absolute file>` to verify an exact candidate without
repacking. It is not a release step. The supplied tarball remains intact.
Its installed name and version must match the source metadata. Installation,
CLI execution, generic grading, prompt-only execution, release provenance,
reporting, and supported deterministic native fixtures run without source Git
metadata in the installed package.

## Maintainer workflow

Release already verified code. Do not rerun tests locally or in CI as part of a
release: reuse the successful source CI run. Code, dependencies, schemas, tests,
examples, license changes, and other quality inputs belong in ordinary changes
with their own CI before starting the release.

1. Start a release branch from verified `main`. Update `package.json.version`
   to a new release version, keep the selected license, and run `bun run docs:sync`.
   Set `publishConfig.tag` to `latest` for the recommended default or `next`
   for an opt-in preview. Commit and open a pull request; every release commit
   must reach `main` through a PR. Never attempt a direct release push to `main`.
2. Merge the release PR after its static checks and reused CI evidence pass.
   Release CI compares the candidate against a successful ancestor run on
   `main`, permitting only version/distribution-tag changes and the exact
   release documentation and workflow files inventoried in
   [the CI selector](../.github/scripts/release-ci.py). All other tracked inputs
   must match. The original run must have completed the full quality gate;
   another release's reused status is insufficient. CI retains the source SHA
   and run URL in `release-ci.json`. Missing evidence fails the release check;
   it does not trigger another test run. Ordinary code changes and explicit
   workflow dispatches continue to run the full gate.
3. From the clean, merged release commit, use macOS, Bun 1.3.13, Node 24,
   and npm to prepare one exact candidate:

   ```sh
   bun install --frozen-lockfile
   bun run release:prepare --tag "v${SEVRO_RELEASE_VERSION:?set the selected new release version}" --output /absolute/new/release-directory
   ```

4. Inspect the version, repository, license, distribution tag, file inventory,
   and retained checksums. Publish that tarball with lifecycle scripts disabled
   using the commands below. Do not run `check:typescript`, `test:package-install`,
   Darrow's archive/installed gates, or native trials during release. Diagnostic
   tests require a separate explicit request.
5. Once npm serves the version, compare `dist.integrity` with `release.json`
   and verify the intended distribution tag:

   ```sh
   npm view "@bjoernrochel/sevro@${SEVRO_RELEASE_VERSION}" version dist.integrity --json
   npm view @bjoernrochel/sevro dist-tags --json
   ```

   npm may take a few minutes to process the accepted upload. Wait for the
   registry record rather than republishing. Retain the reviewed tarball,
   checksums, and original CI evidence.

6. Create the matching Git tag at the merged release commit and push only the tag:

   ```sh
   git tag -a "v${SEVRO_RELEASE_VERSION}" -m "Release ${SEVRO_RELEASE_VERSION}"
   git push origin "refs/tags/v${SEVRO_RELEASE_VERSION}"
   ```

Darrow dependency/lockfile updates and compatibility gates are a separate
Darrow PR, not prerequisites for npm publication. A prerelease does not establish
full Darrow migration completion. Preserve prior-version evidence for updates
and rollback; never relabel failed-version evidence.

## Local macOS publication

There is no GitHub release job. The maintainer prepares, inspects, and publishes
the reviewed tarball from macOS with an authenticated npm account. Check its
retained checksum immediately before publication:

```sh
cd /absolute/reviewed
shasum -a 256 -c SHA256SUMS
npm publish ./bjoernrochel-sevro-0.1.0-rc.1.tgz --ignore-scripts --access public --tag latest
```

Replace the example version and distribution tag with the reviewed candidate's
values. The package repository URL must match this public repository. Preparing
a tarball or opening a pull request does not authorize publication.

An existing published candidate can become the default without republishing:

```sh
npm dist-tag add @bjoernrochel/sevro@0.1.0-rc.2 latest
npm view @bjoernrochel/sevro dist-tags --json
```

Promotion changes the registry tag; it does not update the published tarball.

The first published candidate was `0.1.0-rc.1`, using the owner-selected
`BUSL-1.1` license. Its `LICENSE` preserves Darrow's terms and parameters,
changing only the Licensed Work name and description to Sevro. Local checks do
not claim a remote CI run or publication. Darrow's exact
registry pin, default caller switch, remaining workflow migrations, focused live validation, and
generic runner removal remain separate extraction gates.
