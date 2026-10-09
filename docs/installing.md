# Install, update, or remove Sevro

Use Bun 1.3.13 for this TypeScript/Bun CLI. Installation does not make it a
Node-only executable. Full validation and native isolation target macOS;
Linux and Windows are unverified.

## Install locally

```sh
mkdir sevro-demo
cd sevro-demo
bun init -y
```

Then install the [current release](#current-release) in that directory.

Run the [packaged deterministic example](getting-started.md#from-an-installed-package)
to verify installation. It needs neither model credentials nor Darrow.
Local installation records the selected version in the project lockfile.

<!-- sevro-current-release:start -->

## Current release

The current release is `0.1.0-rc.3`. Install this exact version:

```sh
bun add --exact @bjoernrochel/sevro@0.1.0-rc.3
```

<!-- sevro-current-release:end -->

## Make the command available

The examples call `sevro` from `PATH`. For a local installation, run this from
the directory containing its `node_modules`:

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
```

This selects the locally installed version for the current shell, including
after changing directories. If your installed `sevro` is already on `PATH`,
no adjustment is needed. Bun must also be on `PATH`: the executable uses
`#!/usr/bin/env bun`.

## Published package and checkout

The [current release](#current-release) includes runtime
configuration, native goals, selected plugin hooks, current onboarding, and
[source-available licensing terms](licensing.md). Earlier `rc.1` and `rc.2`
packages retain BUSL-1.1. The license transition began with `0.1.0-rc.3`.
Source checkouts can include changes beyond their
package version; compare the exact release tag when establishing provenance.

The candidate npm package contains sources, schemas, examples, documentation,
LICENSE, and contribution guidance. It excludes tests, developer scripts, Git
metadata, and repository guide mounts. Use a source checkout for the guide.

## Work from source

```sh
git clone https://github.com/BjRo/sevro.git
cd sevro
bun install --frozen-lockfile
```

Run the [checkout tutorial](getting-started.md#from-a-contributor-checkout).
`bun run test:package-install` packs and installs a local tarball in temporary
directories; it does not publish. [Contributing](../CONTRIBUTING.md) lists checks.

## Update

Review a release's license and compatibility, then use the exact installation
command for the [current release](#current-release) from your existing project.
To select a different published version, substitute that exact version in the
command, then rerun the [packaged example](getting-started.md#from-an-installed-package).
Rollback uses the prior exact version and another verification run.
[Releases](releases.md) explains artifact provenance.

## Remove

```sh
bun remove @bjoernrochel/sevro
```

This updates the dependency and lockfile, not saved cases, results, or model
logins. Remove those separately only when wanted.
