# Releases

Sevro releases are public npm packages named `@bjoernrochel/sevro`. The public
command remains `sevro`, and npm archives use `bjoernrochel-sevro-<version>.tgz`.
A release version is an
exact semantic version; development versions containing `-dev` are not release
candidates. Darrow pins the published version in development dependencies and
its lockfile. Marketplace plugins do not depend on Sevro.

This checkout's new [licensing terms](licensing.md) are unreleased. Published
`rc.1` and `rc.2` retain their original BSL grants. Select a new version before
publishing these changes; a local development tarball does not replace an
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
2. Run frozen installation, typecheck, formatting, and the full test suite.
3. Prepare and test the exact candidate:

   ```sh
   bun run release:prepare --tag "v${SEVRO_RELEASE_VERSION:?set the selected new release version}" --output /absolute/new/release-directory
   bun run test:package-install --tarball "/absolute/new/release-directory/bjoernrochel-sevro-${SEVRO_RELEASE_VERSION}.tgz"
   ```

4. Run Darrow's public integration against that same tarball:

   ```sh
   SEVRO_PACKAGE_TARBALL="/absolute/new/release-directory/bjoernrochel-sevro-${SEVRO_RELEASE_VERSION}.tgz" bun run test:eval-runner-sevro-package
   ```

5. Review the changes, file inventory, retained checks, and compatibility
   limitations before authorizing publication. Keep the reviewed tarball and
   its checksums. Publish that artifact rather than repacking after review.
6. After publication, verify registry integrity, install the exact version in
   Darrow, and run its frozen installed compatibility gate. Retain the prior
   version's evidence for updates. Roll back through a new dependency/lockfile
   commit and rerun the installed gate; never relabel failed-version evidence.

## Manual release workflow

`.github/workflows/release.yml` runs only through explicit dispatch against a
release tag. Its default prepares and checks the artifact. `publish: true`
additionally publishes that verified artifact using npm trusted publishing.
No push or pull-request event publishes a package.

Before the first publication, an npm owner must establish the package and its
publishing authorization. The initial reviewed tarball can be published
manually with an authenticated npm account:

```sh
npm publish /absolute/reviewed/bjoernrochel-sevro-0.1.0-rc.1.tgz --ignore-scripts --access public --tag latest
```

After the package exists, configure its trusted publisher for GitHub owner
`BjRo`, repository `sevro`, and workflow filename `release.yml`. The workflow
uses a GitHub-hosted runner, Node 24, npm 11.20.0, and job-scoped `id-token: write`.
The package repository URL must match this public repository. See npm's
[trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
The workflow checks the downloaded artifact's SHA-256 before publishing and
retains its release record. Configuring an owner or workflow does not itself
authorize this coding session to publish or push.

An existing published candidate can become the default without republishing:

```sh
npm dist-tag add @bjoernrochel/sevro@0.1.0-rc.2 latest
npm view @bjoernrochel/sevro dist-tags --json
```

Promotion changes the registry tag; it does not update the published tarball.

The first published candidate was `0.1.0-rc.1`, using the owner-selected
`BUSL-1.1` license. Its `LICENSE` preserves Darrow's terms and parameters,
changing only the Licensed Work name and description to Sevro. Neither local
checks nor a workflow file claim a remote CI run or publication. Darrow's exact
registry pin, default caller switch, remaining workflow migrations, focused live validation, and
generic runner removal remain separate extraction gates.
