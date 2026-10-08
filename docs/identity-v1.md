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

The CLI derives `runnerBuildDigest` from sorted packaged file paths and their
SHA-256 bytes under `src/`, `schemas/`, `docs/`, and `examples/`, plus `README.md` and
`package.json`. For a Git project, `projectDigest` binds the revision and dirty
patch digest without the checkout path. Without a revision it hashes a bounded
file snapshot, excluding `.git`, results, and run-state storage. A caller may
provide explicit 64-character digests for controlled development runs.

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

Selected [runtime configuration](runtime-v1.md) is retained under
`configuration.redacted.runtimePolicy` and enters `configurationDigest`.
It includes declared non-secret environment values, canonical read roots,
private seed digests, and hook authority. Per-role output paths are resolved
only during execution; runtime placeholders remain symbolic in identity.
