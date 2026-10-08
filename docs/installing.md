# Install, update, or remove Sevro

Use Bun 1.3.13 for this TypeScript/Bun CLI. Installation does not make it a
Node-only executable. Full validation and native isolation target macOS;
Linux and Windows are unverified.

## Install locally

```sh
mkdir sevro-demo
cd sevro-demo
bun init -y
bun add --exact @bjoernrochel/sevro@0.1.0-rc.2
```

Run the [packaged deterministic example](getting-started.md#from-an-installed-package)
to verify installation. It needs neither model credentials nor Darrow.
Local installation records the selected version in the project lockfile.

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

On 2026-10-07 npm `latest` points to `0.1.0-rc.2`, published under BUSL-1.1.
The commands above pin it. This checkout contains subsequent runner fixes,
new onboarding, and [different licensing terms](licensing.md). Its package
version alone does not prove those changes have been published.

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

Review a release's license and compatibility, then install its exact version:

```sh
bun add --exact @bjoernrochel/sevro@0.1.0-rc.2
```

Here `rc.2` is the known published version, not a claim that an upgrade is
available. Substitute the intended published version, then rerun the example.
Rollback uses the prior exact version and another verification run.
[Releases](releases.md) explains artifact provenance.

## Remove

```sh
bun remove @bjoernrochel/sevro
```

This updates the dependency and lockfile, not saved cases, results, or model
logins. Remove those separately only when wanted.
