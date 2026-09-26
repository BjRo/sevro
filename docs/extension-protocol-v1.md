# Extension protocol v1

This is the target public contract for `sevro.extension.v1`. Extensions are
explicitly configured development tools. Installing one does not change
built-in grading or grant it control of fixture isolation, execution,
persistence, or cleanup. The executable is trusted by the operator; a process
boundary alone is not a sandbox.

## Transport

The runner receives an extension command as an argv array and never interprets
it through a shell. For each method it starts a fresh process, writes exactly
one UTF-8 JSON request to stdin, closes stdin, and reads exactly one UTF-8 JSON
response from stdout before process exit. The request and response are each
limited to 8 MiB. Extra stdout, malformed JSON, an unmatched request ID, a
nonzero exit, timeout, or an oversized message is a protocol error. Stderr is
diagnostic only, bounded to 64 KiB in retained evidence; it cannot supply a
result. The runner cancels the extension process group on interruption.

Every request has this envelope. `describe` uses the stable
`sevro.discovery.v1` bootstrap protocol; subsequent methods use the selected
extension protocol:

```json
{
  "protocol": "sevro.discovery.v1",
  "id": "request-1",
  "method": "describe",
  "params": {}
}
```

A response echoes `protocol`, `id`, and `method`, then supplies exactly one of
`result` or `error`:

```json
{
  "protocol": "sevro.discovery.v1",
  "id": "request-1",
  "method": "describe",
  "result": {
    "extension": { "id": "example.policy", "version": "1.0.0" },
    "protocols": ["sevro.extension.v1"],
    "requiredCapabilities": [],
    "optionalCapabilities": [],
    "graders": [],
    "taskVerdictPolicies": []
  }
}
```

An error has `{ "code": "namespaced.code", "message": "bounded text" }`.
An error response, process failure, or invalid response never becomes a
successful grade. The engine retains the method, error class, and bounded
diagnostic without copying secrets or unbounded extension output.

## Negotiation and operations

The engine calls `describe` first through the discovery protocol. The
extension identifies its stable ID and version, supported protocol versions,
required and optional capability IDs,
grader IDs it supplies, and task-verdict policy IDs it supplies. Capability IDs
are namespaced strings. The engine chooses one compatible protocol, verifies
all required capabilities against its own and the selected host's capability
registry, and records the negotiated set. An unknown required capability is an
error. Unknown optional capabilities remain unavailable and cannot be used.
The engine, not the extension, classifies whether instrumentation changes host
execution. Future extension protocols still need a compatible discovery
response or an explicitly selected bridge; an unsupported protocol cannot be
guessed from a failed extension call.

`resolve` receives the selected project root, selectors, and extension
configuration. It returns neutral case descriptions with stable IDs, prompts,
fixture and built-in check declarations, required evidence declarations, and
namespaced extension data. Paths in case descriptions are resolved and
validated by the engine against the declared project and case-source roots.
The extension cannot add a hidden source root by returning an arbitrary path.

`prepare` receives one resolved case, the chosen host and capabilities, the
configured passive or enforced condition, and extension data. It returns
fixture preparation artifacts and requested instrumentation IDs with
parameters. The engine validates and applies these requests before host
execution. It rejects unknown or unsupported IDs and rejects any
execution-changing instrumentation in a passive trial. Requested and applied
instrumentation are recorded separately.

`evaluate` receives one completed or failed trial's bounded host observations,
their source and completeness, built-in check results, artifact references,
and the extension's namespaced case data. It returns namespaced checks and
metrics. A check is `passed`, `failed`, or `unavailable`; it names the evidence
used. A missing required observation remains unavailable. The extension may
return a task-verdict recommendation only when an explicitly configured
task-verdict policy names that extension policy. The engine computes the final
verdict and cannot let that recommendation conceal execution failure, grader
error, or unavailable required evidence.

The methods are stateless. Every request carries the configuration and prior
extension data it needs. The runner verifies extension identity and source
digest for the run; a changed executable or configuration cannot silently
continue the same run.

## Grading and replacement

The runner provides built-in shell, regex, JSON/schema, semantic-output, and
advisory quality graders. A run can use those without any extension. An
extension's graders add checks and metrics by default. The run configuration
must explicitly name each built-in grader it replaces, or explicitly select
one advertised task-verdict policy. Unknown or duplicate replacement IDs are
errors. Retained evidence lists every active grader, its identity and route,
and any replaced default.

An extension cannot replace execution status, grading status, or the evidence
availability rules. It cannot turn an error or missing required evidence into
a successful task assessment. A prompt without success criteria produces
execution evidence and a task verdict of `not_assessed`.

## Lifecycle

The engine orders each trial as follows:

1. Negotiate protocol and capabilities; resolve the case.
2. Prepare the fixture and extension inputs; validate instrumentation against
   the host and passive/enforced condition.
3. Execute or resume the host and collect bounded observations.
4. Run built-in checks, then extension grading, then compute separate
   execution, grading, and task states.
5. Persist complete trial evidence before fixture cleanup.

On cancellation or failure, completed trials remain persisted and partial
attempts retain an explicit incomplete or diagnostic state. The engine owns
process-group cancellation and cleanup even when an extension fails. A dry
run records preparation but no observed behavioral success.
