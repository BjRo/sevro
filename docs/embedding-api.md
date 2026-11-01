# Run evaluations in your application

Import `evaluate` from `@bjoernrochel/sevro` to prepare and execute an evaluation
in the calling Node or Bun process. It uses the same options, saved settings,
runtime configuration, host selection, case loading, and identity calculation as
[`sevro run`](development-cli.md). You do not need to calculate identity digests.
Node requires the [supported runtime](installing.md); Bun is not required for an
installed Node application. Native hosts and isolated checks retain their
[existing prerequisites](native-hosts.md).

## Try a deterministic installed consumer

In a new directory, [install Sevro](installing.md#current-release), then prepare
an ESM TypeScript consumer:

```sh
npm init -y
npm pkg set type=module
npm install --save-dev typescript @types/node
mkdir project
```

Save this as `evaluation.ts`. The bundled case and adapter require no model
account. The separate `project` directory keeps consumer dependencies outside
the evaluated project snapshot.

```typescript
import { fileURLToPath } from "node:url";
import {
  evaluate,
  type EvaluateOptions,
  type EvaluationResult,
} from "@bjoernrochel/sevro";

const entrypoint = import.meta.resolve("@bjoernrochel/sevro");
const caseFile = fileURLToPath(
  new URL("../../examples/basic/graded.json", entrypoint),
);
const adapter = fileURLToPath(
  new URL("../../dist/examples/basic/host.js", entrypoint),
);
const options: EvaluateOptions = {
  argv: [
    "run",
    "--case-file",
    caseFile,
    "--adapter-module",
    adapter,
    "--project-root",
    "./project",
    "--results-root",
    "./results",
  ],
};
const result: EvaluationResult = await evaluate(options);
console.log(result.task.verdict); // passed
console.log(result.evidencePath); // absolute retained run.json path
```

Compile and execute it with Node:

```sh
npx tsc evaluation.ts --target ES2022 --module NodeNext --moduleResolution NodeNext --strict
node evaluation.js
```

The result is `completed` / `completed` / `passed`, with `exitCode: 0` and one
passing regex check in `result.cases[0].trials[0].checks`. The package includes
JavaScript and the public declaration dependency closure. Strict NodeNext and
Bundler module resolution are supported without checkout types or Bun types.
For a Bun consumer, `bun evaluation.ts` runs the same example.

## Inputs and results

`evaluate(options: EvaluateOptions): Promise<EvaluationResult>` accepts:

| Input         | Meaning                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `argv`        | Readonly argument array beginning with `"run"`. All [run options](development-cli.md), defaults and [saved-setting precedence](run-settings-v1.md) apply. Relative CLI paths resolve from the caller's current directory. |
| `signal?`     | Caller-owned `AbortSignal`, passed through to extension resolution and execution.                                                                                                                                         |
| `onProgress?` | Synchronous best-effort callback receiving `EvaluationProgress`: `stage`, `status` and optional `trial`. Observer exceptions are ignored.                                                                                 |
| `onWarning?`  | Synchronous callback receiving deprecation and cleanup diagnostics. Omission suppresses warnings. Deprecation callback exceptions reject preparation; cleanup callback exceptions are ignored.                            |

The package also exports `EvaluationCaseResult`, `EvaluationTrialResult` and
`EvaluationProgress` types. The result follows the [result contract](results-v1.md),
including execution, grading and task states, check outcomes, domain outcomes,
and diagnostics. Returned evaluations always have string `runId` and
`evidencePath` fields. A failed assessment resolves with `task.verdict: "failed"`
and `exitCode: 1`; host and grading failures also resolve when the engine can
retain their result. Missing criteria remain `not_assessed`.

Invalid invocation, configuration or case inputs reject with an `Error` carrying
the shared validation diagnostic. For example, appending `"--threshold", "2"`
rejects with `invalid --threshold`. Setup, extension-resolution, internal and
persistence failures can also reject; retain the error and its cause for
diagnosis. A rejected call does not promise a completed result or evidence path.

The API itself writes no console output and never changes `process.exitCode`.
`--json` is accepted but has no presentation effect. It retains engine evidence
and trial artifacts under the selected storage roots; CLI `result.json` and
`latest.json` presentation files are created only by the CLI. Custom adapters
and extensions remain responsible for their own output and other side effects.

## Cancel and observe a run

Pass your own controller and cancel it when your application needs to stop:

```typescript
const controller = new AbortController();
const pending = evaluate({
  ...options,
  signal: controller.signal,
  onProgress(event) {
    console.log(event.stage, event.status, event.trial);
  },
});
controller.abort("SIGINT");
const interrupted = await pending;
console.log(interrupted.execution.status); // cancelled when execution is interrupted
```

The API installs no process signal handlers. Your application decides whether
an OS signal, timeout or user action should abort the controller. Cancellation
stops queued trials, drains active work, and retains completed or partial trial
evidence according to the [existing lifecycle](results-v1.md). An abort reason of
`"SIGINT"` or `"SIGTERM"` yields summary code `130` or `143` respectively;
other reasons use the ordinary execution-cancelled summary code `2`. Inspect
the state fields as well as the summary code. Cancellation during setup or
extension resolution can reject before an evaluation is allocated.

Return to the [documentation hub](README.md).
