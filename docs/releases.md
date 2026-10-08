# Releases

Sevro releases are public npm packages named `@bjoernrochel/sevro`. The public
command remains `sevro`, and npm archives use `bjoernrochel-sevro-<version>.tgz`.
A release version is an
exact semantic version; development versions containing `-dev` are not release
candidates. Darrow pins the published version in development dependencies and
its lockfile. Marketplace plugins do not depend on Sevro.

Release candidate `0.1.0-rc.3` uses the current [licensing terms](licensing.md).
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

The package installation check accepts `--tarball <absolute file>` to verify
that exact candidate without repacking. The supplied tarball remains intact.
Its installed name and version must match the source metadata. Installation,
CLI execution, generic grading, prompt-only execution, release provenance,
reporting, and supported deterministic native fixtures run without source Git
metadata in the installed package.

## Maintainer workflow

1. Select the license, update `package.json` to the intended release version,
   and commit those changes. Preserve the existing public schemas and document
   behavior changes. Set `publishConfig.tag` to `latest` for the recommended
   default or `next` for an opt-in preview. A prerelease does not establish full
   Darrow migration completion.
2. On macOS with Bun 1.3.13, Node 24, npm, and `sandbox-exec`, run frozen
   installation and the full quality gate:

   ```sh
   bun install --frozen-lockfile
   bun run check:typescript
   ```

3. Prepare and test the exact candidate:

   ```sh
   bun run release:prepare --tag "v${SEVRO_RELEASE_VERSION:?set the selected new release version}" --output /absolute/new/release-directory
   bun run test:package-install --tarball "/absolute/new/release-directory/bjoernrochel-sevro-${SEVRO_RELEASE_VERSION}.tgz"
   ```

4. Run Darrow's public integration against that same tarball:

   ```sh
   SEVRO_PACKAGE_TARBALL="/absolute/new/release-directory/bjoernrochel-sevro-${SEVRO_RELEASE_VERSION}.tgz" bun run test:eval-package
   ```

5. Review the changes, file inventory, retained checks, and compatibility
   limitations before authorizing publication. Keep the reviewed tarball and
   its checksums. Publish that artifact rather than repacking after review.
6. After publication, verify registry integrity, install the exact version in
   Darrow, and run its frozen installed compatibility gate. Retain the prior
   version's evidence for updates. Roll back through a new dependency/lockfile
   commit and rerun the installed gate; never relabel failed-version evidence.

## Local macOS publication

There is no GitHub release job. The maintainer prepares, verifies, and publishes
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
