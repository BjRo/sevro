# Evaluation identity v1

`sevro.identity.v1` binds retained evidence to the inputs that can change an
assessment. Its `dimensions` object has exactly the fields required by
[`run-evidence-v1.schema.json`](../schemas/run-evidence-v1.schema.json). The
runner computes each `*Digest` from the relevant normalized content. It must
not use a temporary path, run ID, or timestamp as an input.

| Dimension                                  | Content represented                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `runnerBuildDigest`                        | Exact installed package build or local runner source build.                                    |
| `projectDigest`                            | Evaluated project revision and dirty content, or a content snapshot without Git.               |
| `configurationDigest`                      | Evaluation settings with credentials replaced by secret-presence markers.                      |
| `extensionDigest`, `extensionProtocol`     | Extension source closure and negotiated protocol, or both `null`.                              |
| `caseDigest`, `fixtureDigest`              | Resolved case declaration and fixture contents.                                                |
| `checksDigest`, `requiredEvidenceDigest`   | Declared checks and evidence requirements.                                                     |
| `evaluatorDigest`, `graderDigest`          | Evaluator policy, grader versions, active selection, and replacements.                         |
| `instrumentationDigest`                    | Requested instrumentation and expected application; trial evidence records actual application. |
| `routeDigest`                              | Candidate, semantic, and advisory host/model/effort routes.                                    |
| `condition`, `trialCount`, `passThreshold` | Declared condition and assessment sampling rule.                                               |

Each structured component digest is SHA-256 of its [RFC 8785 JSON
Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html) UTF-8
bytes. The runner rejects values outside canonical JSON, including non-finite
numbers and unpaired Unicode surrogates. The final evaluation digest is:

```text
SHA-256(UTF-8("sevro.identity.v1\n") || UTF-8(JCS(dimensions)))
```

The TypeScript distribution derives `runnerBuildDigest` from sorted packaged file paths and their
SHA-256 bytes under `src/`, `schemas/`, `docs/`, and `examples/`, plus `README.md` and
`package.json`. For a Git project, `projectDigest` binds the revision and dirty
patch digest without the checkout path. Without a revision it hashes a bounded
file snapshot, excluding `.git`, results, and run-state storage. Results and
run-state storage are also excluded from untracked Git identity, so repeated
project-local output does not change the project digest. Tracked source changes
remain included, even under a selected storage directory. A caller may
provide explicit 64-character digests for controlled development runs.

Native Rust distributions bind the installed executable and separately shipped
assessment assets. The current standalone build embeds its help, schemas,
templates and adapter bridge in the executable; it has no separately shipped
assessment assets. Its build digest is SHA-256 of the JCS bytes of:

```json
{
  "format": "sevro.native-build.v1",
  "distribution": "standalone",
  "executableSha256": "<SHA-256 of the actual running executable bytes>",
  "assets": []
}
```

The executable's installation path does not enter that input. Relocating the
same executable preserves its build identity; compiler, dependency, build-flag
or platform changes that alter its bytes change the identity. No source-checkout
path or nearby package directory supplies an installed binary's identity.
Explicit digest overrides take precedence over this default computation.

The optional Rust `native-bundle` feature explicitly compiles the bundle profile.
Its executable must be installed at `<bundle>/bin/sevro`, beside the root manifest
`<bundle>/sevro-native-bundle.json`. The manifest has exactly these fields:

```json
{
  "format": "sevro.native-bundle.v1",
  "executable": "bin/sevro",
  "assets": ["<sorted package-relative file paths>"]
}
```

`assets` lists every ordinary file in `docs/`, `examples/`, `schemas/`, and `src/`,
plus `package.json`, `README.md`, `LICENSE`, and `CONTRIBUTING.md`. Paths are sorted
by UTF-16 code units and unique. They use `/` separators, have no empty, `.` or
`..` components, backslashes or NUL bytes, and stay within those mandatory roots.
The roots, manifest, and their contents must be ordinary directories/files;
symbolic links and non-file assets refuse. The inventory must match the installed
files exactly. Required sentinels are `docs/installing.md`,
`examples/basic/{graded.json,prompt-only.json,host.ts}`,
`schemas/{run-evidence-v1.schema.json,report-v1.schema.json}`, and `src/cli.ts`.
`package.json` must name `@bjoernrochel/sevro` and match the executable's version.
The manifest plus assets are bounded to 4,096 files and 64 MiB in total.

The bundle uses the same `sevro.native-build.v1` envelope with
`"distribution": "bundle"`, the actual executable digest, and an `assets` array
of `{ "path": "...", "sha256": "..." }` entries sorted by UTF-16 path order.
That array includes the manifest's actual bytes as well as all listed assets.
Relocation preserves the digest; changing any bound bytes changes it. Automatic
identity refuses missing layout, an invalid manifest, or missing assets. Copying
the executable out of its bundle cannot downgrade it to standalone identity or
discover a nearby source checkout. Explicit digest overrides still take priority.

This opt-in profile does not change npm installation or reinterpret historical
TypeScript or standalone build digests. Native checkout association requires a
separate verified source receipt; hashing the executable alone does not establish
that a supplied mutable checkout produced it.

The prefix separates this digest from component digests and future identity
versions. An exact-repeat comparison requires equal identities. An ablation may
deliberately differ on `condition` or instrumentation; its report must name
those dimensions and verify that the intended controls match. Historical
artifacts without a dimension cannot be silently assigned a current identity.

Credential values, raw transcripts, and temporary output locations never enter
the stored dimensions. A credential's presence can be recorded in a redacted
configuration; its bytes are never retained in evidence or its digest input.
The effective positive trial job limit is retained as `configuration.redacted.jobs`
and enters `configurationDigest`. Changing parallelism changes evaluation identity,
even when the condition, host route, trial count, and assessment threshold match.

CLI [saved run settings](run-settings-v1.md) resolve before evaluation. Equivalent
manifest and explicit selections produce the same semantic inputs. CLI evidence
also retains `configuration.redacted.runSettings` for shell isolation, explicit
protected roots, deprecated runtime selections, selected native timeouts and
Claude project-settings authority. These values enter the
configuration digest. Optional `configuration.resolved` stores the whitelisted
operator preview outside that digest, including operational paths and the
selected manifest location. Relocating output storage alone does not alter
identity. A tracked manifest remains project content under the normal project
identity rules.

Extension runs retain the operator-supplied redacted extension configuration
under `configuration.redacted.extensionConfiguration`, alongside
`extensionConfigurationDigest`. The retained copy is the same snapshot used
for extension configuration identity. Private configuration stays outside run
evidence. Consumers can compare the visible configuration with their declared
inputs without reconstructing the engine's component digest inputs.

Hosts may supply explicit, redacted `configuration` values. Sevro retains them
under `configuration.redacted.hostConfiguration`, keyed by the used candidate,
semantic, or advisory role, and includes them in `configurationDigest`. Custom
adapter authors must keep secrets out of this object. Bundled Codex roles record
`sevro.codex.agent-concurrency-limit` as the captured positive integer or `null`
for the host default. Configuration paths and unrelated TOML bytes are not
imported settings; a relocated configuration with the same effective values
keeps this component unchanged.

Opted-in bundled native roles also record `sevro.host.retain-diagnostics: true`.
The [diagnostic retention switch](development-cli.md#retain-native-host-diagnostics)
therefore changes `configurationDigest`. Omission leaves that host setting
absent and preserves the previous configuration shape. Retained diagnostic
contents and temporary native state paths do not enter identity.

Selected [runtime configuration](runtime-v1.md) is retained under
`configuration.redacted.runtimePolicy` and enters `configurationDigest`.
It includes declared non-secret environment values, canonical read roots,
private seed digests and optional role selections, and hook authority. Per-role output paths are resolved
only during execution; runtime placeholders remain symbolic in identity.
Runtime roots also retain lexical aliases, metadata discovery sources,
and skipped optional directories. Moving or
changing the effective host grants changes identity, even when the portable
configuration file is unchanged. External installation contents remain outside
this digest unless explicitly captured as private seed inputs.
