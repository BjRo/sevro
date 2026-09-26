# First engine slice

`runEvaluation` accepts a resolved inline-fixture case and an injected host
adapter. It is an internal API while the host isolation adapters, extension
lifecycle, and public CLI are being built. The synthetic adapter in the tests
exercises the actual engine path without a model call.

The engine validates check configuration and fixture paths before execution.
For each trial it creates a separate workspace, asks the adapter to run the
prompt, grades its bounded final message, writes the raw-message reference and
trial artifact, and only then removes the workspace. An adapter exception
becomes an execution failure; a later failure leaves earlier trial artifacts
intact. A failed trial checkpoint retains its fixture and cannot produce a
successful result.

The final `run.json` follows the v1 evidence schema and contains separate
execution, grading, and task states. It records the exact runner build and
project content digests supplied by the caller, plus a computed evaluation
identity. Missing optional usage stays `null` and incomplete. Results storage
is explicit and independent of the project root; the engine does not invoke
Git.

This slice accepts output checks with no additional required host evidence.
It rejects other evidence requirements rather than treating them as passing.
The future host adapters must provide fixture isolation, credential
protection, and verified condition observations before the CLI can expose
model-backed runs.
