# Create cases and extensions

Start with a direct case for a prompt, fixture, and built-in success criteria.
Copy [the basic graded case](../examples/basic/graded.json), give it a stable
ID, and replace the prompt/check. Read [built-in graders](builtin-graders-v1.md)
for regex, JSON, and bounded schema assertions. No criteria means `not_assessed`.

Run it with the [CLI](running-evaluations.md). Direct cases follow `ResolvedCase`
in [the engine](../src/engine.ts). Fixtures can provide inline files, generated
Git history, or a declared clean repository. The [CLI reference](development-cli.md)
owns required source roots/maps; an arbitrary returned path does not grant access.

## Reusable project policy

Use an extension for project-specific discovery, preparation, checks, or
task-verdict policy. [Extension protocol v1](extension-protocol-v1.md) is the
contract, backed by [its schema](../schemas/extension-v1.schema.json).

An extension is an explicitly trusted executable. Each process accepts one JSON
request and returns one matching response. `describe` negotiates identity and
capabilities; `resolve` supplies cases; `prepare` supplies artifacts and
negotiated requests; `evaluate` supplies extension results. A process boundary
alone is not a sandbox. Diagnostics use stderr. Keep secrets out of argv,
redacted configuration, observations, and artifact references.

Use an argv-array command file, declare source files, and select a case ID as
shown in the CLI reference. Replacing built-ins or using an extension verdict
policy needs explicit selection. These are separate controls: choosing a task
verdict policy does not disable built-in checks. Unsupported capabilities, incomplete evidence,
and failed exchanges cannot produce a pass. Separate participant-visible inputs
from evaluator checks; version policy and preserve its [comparison identity](identity-v1.md).
