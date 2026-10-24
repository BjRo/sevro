# Install, update, or remove Sevro

The installed package contains compiled JavaScript and runs with Node.js
24.13.0 or newer, or Bun 1.3.13. Node users do not need Bun for installation
or execution. Development and release builds continue to use Bun. Native
isolation targets macOS and Ubuntu 24.04 x64. See the [bounded platform evidence](native-hosts.md#validated-platform-scope);
Windows remains unverified.

## Node support preview

Node support is unreleased in this checkout. The [current registry release](#current-release)
still requires Bun; its version number does not establish that these changes
have been published. Node users can install a candidate archive built from this
checkout until the next release is published.

A contributor with Bun prepares that archive from the checkout:

```sh
bun install --frozen-lockfile
bun run build
npm pack --ignore-scripts
```

The last command prints the archive filename. Transfer that file to the Node
consumer, then install it without Bun:

```sh
npm install --save-exact /absolute/path/to/candidate.tgz
```

Continue with the installed-package tutorial below. Registry users should use
the instructions bundled with their published version until the preview ships.

## Install locally

```sh
mkdir sevro-demo
cd sevro-demo
npm init -y
```

Then install the [current release](#current-release) in that directory.

Run the [packaged deterministic example](getting-started.md#from-an-installed-package)
to verify installation. It needs neither model credentials nor Darrow.
Local installation records the selected version in the project lockfile.

<!-- sevro-current-release:start -->

## Current release

The current release is `1.0.0`. Install this exact version with npm:

```sh
npm install --save-exact @bjoernrochel/sevro@1.0.0
```

Or with Bun:

```sh
bun add --exact @bjoernrochel/sevro@1.0.0
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
no adjustment is needed. The executable uses `#!/usr/bin/env node`, so Node
must be on `PATH` for a direct `sevro` invocation. For Bun execution, use
`bun run --bun sevro` from the installation directory, or run
`bun ./node_modules/@bjoernrochel/sevro/dist/src/cli.js` with the same arguments.
Bun-only users can initialize with `bun init -y` and install with `bun add`.

## Published package and checkout

See [licensing](licensing.md) for Sevro's source-available terms and historical
licensing transitions.

The npm package contains compiled runtime and example modules under `dist/`,
alongside TypeScript sources, schemas, examples, documentation,
LICENSE, and contribution guidance. It excludes tests, developer scripts, Git
metadata, and repository guide mounts. Use a source checkout for the guide.

Source checkouts can include changes beyond their package version; compare the
exact release tag when establishing provenance.

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
npm uninstall @bjoernrochel/sevro
```

With Bun, use `bun remove @bjoernrochel/sevro`.

This updates the dependency and lockfile, not saved cases, results, or model
logins. Remove those separately only when wanted.
