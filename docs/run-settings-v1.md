# Saved run settings v1

Save recurring evaluation selections in a JSON run manifest, then use
`sevro run --run-manifest-file ./evaluation.json`. The examples use the
[installed command](installing.md#make-the-command-available).

## Repeat an evaluation

Start with an existing [resolved case and adapter](getting-started.md), and save
this `evaluation.json` beside `case.json` and `host-adapter.js`:

```json
{
  "format": "sevro.run.v1",
  "settings": {
    "case-file": "./case.json",
    "adapter-module": "./host-adapter.js",
    "project-root": ".",
    "condition": "passive",
    "trials": 3,
    "jobs": 1,
    "threshold": 1
  }
}
```

Run it twice with the same saved selections, or explicitly override one setting:

```sh
sevro run --run-manifest-file ./evaluation.json
sevro run --run-manifest-file ./evaluation.json
sevro run --run-manifest-file ./evaluation.json --trials 1 --json
```

Every run prints effective settings on stderr before candidate execution, then
prints the result and evidence location. The example requires all assessed
trials to pass. A missing assessment remains `not_assessed`. Use `--dry` to
check preparation without calling the candidate or graders; dry preparation
does not prove native authentication or task success.

## Select candidate and grading routes once

For native execution, replace the adapter selection with an explicit host,
model and effort. Each grading role has its own selection. For example, a case
with semantic checks can use this manifest:

```json
{
  "format": "sevro.run.v1",
  "settings": {
    "case-file": "./semantic-case.json",
    "project-root": ".",
    "host": "codex",
    "model": "<candidate-model>",
    "effort": "medium",
    "codex-auth-file": "../private/auth.json",
    "semantic-host": "codex",
    "semantic-model": "<grading-model>",
    "semantic-effort": "high",
    "trials": 3,
    "threshold": 1
  }
}
```

Replace model placeholders with installed-host-supported model names and supply
the [native prerequisites and authentication](native-hosts.md). Models and
efforts are never inferred or copied between roles. Candidate Claude uses
`host: "claude"` and its own explicit `model`/`effort`. An optional advisory
route uses `advisory-host`, `advisory-model` and `advisory-effort`; advisory
review requires a Git fixture and remains separate from the task verdict.
Injected adapters continue to declare their own model and effort.

## Format, precedence and paths

The root has exactly `format: "sevro.run.v1"` and an object `settings`. Settings
use the [CLI option names](development-cli.md) without the leading `--`.
All run options can be saved except `json` and `run-manifest-file`. Keep output
presentation explicit on the command line, including `--json` when collecting
a versioned success or failure document. Manifests do not include other
manifests and are read only when explicitly selected; there is no discovery.

| Option kind                                                                             | JSON value                                            |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `trials`, `jobs`, `threshold`, `codex-timeout-ms`                                       | Number, with the CLI's existing ranges                |
| `dry`, `shell-isolation`, `retain-host-diagnostics`, `claude-project-settings`          | Boolean                                               |
| `extension-source-file`, `protected-root`, `replace-builtin-grader`, `advisory-exclude` | Array of nonempty strings; `[]` selects an empty list |
| Other run options                                                                       | Nonempty string                                       |

Precedence is **built-in defaults → saved settings → explicit CLI options**.
Omitted settings retain the [documented defaults](development-cli.md#run-defaults).
An explicit repeatable flag replaces its saved array in full; repeated CLI
occurrences build the replacement array. `--no-dry`, `--no-shell-isolation`,
`--no-retain-host-diagnostics` and `--no-claude-project-settings` override saved
`true` values with `false`.

Selecting an alternative route on the CLI removes its saved alternative and
route-only settings. For example, `--adapter-module ./host-adapter.js` replaces
a saved native candidate and its model/effort. Selecting `--host claude` over
a saved Codex candidate requires fresh explicit `--model` and `--effort`;
grading roles keep their separate selections. Shared Codex settings remain
while any Codex route is selected. CLI `--case-file` replaces a saved extension
source and its extension-only options. CLI `--extension-command-file` replaces
a saved case file; supply the extension's required ID and source closure.
Supplying two exclusive alternatives explicitly remains an error.

Paths saved in a manifest resolve from the **canonical directory containing
that manifest**, including `project-root`, output roots, adapters, protected
roots and extension source files. CLI paths always resolve from the invoking
current directory. `advisory-exclude` contains fixture-relative names, not host
paths. Paths inside case files, extension command argv, source maps and runtime
files retain their existing contracts. A manifest must be a regular,
non-symlink JSON file of at most 64 KiB. Unsupported versions, unknown fields,
invalid types and unreadable files fail before execution with an actionable
file/field diagnostic and exit `64`.

## Runtime, evidence and identity

The existing [`sevro.json` runtime contract](runtime-v1.md) is unchanged.
A run manifest selects recurring evaluation settings; `runtime-config-file`
can select a separate runtime file. Otherwise Sevro still discovers exactly
`<project-root>/sevro.json`. Runtime declarations do not become run options.

Current CLI runs retain the effective preview as optional
`configuration.resolved` in `sevro.run-evidence.v1`, with format
`sevro.resolved-run-settings.v1`. It records selected case and extension command
paths, source-closure count, mapping selection, adapters, routes, model/effort,
trial settings, runtime file selection and operational output locations. It
omits credentials and credential-option paths, private source-closure and mapping
paths, private extension configuration, runtime environment values and native
diagnostic contents. Explicit protected roots, paths and model labels are still operator metadata;
inspect retained evidence before sharing it. The runtime policy's existing
redacted evidence still retains explicitly declared non-secret environment
values. Older evidence without `configuration.resolved` remains valid and
does not acquire inferred settings.

Assessment settings enter the [evaluation identity](identity-v1.md) through
resolved cases, fixtures, checks, routes and `configuration.redacted`. The
additional `configuration.redacted.runSettings` binds shell isolation, explicit
protected roots, deprecated runtime selections, selected native timeouts and
Claude project-settings authority. Equivalent saved and
explicit selections have the same identity. Semantic changes such as model,
effort, trial count, job limit or threshold change identity. The manifest's
location, CLI output mode, and output/run-state paths are excluded from the
semantic configuration digest; `configuration.resolved` is an operational
snapshot outside that digest. Project content, including a tracked manifest,
still follows the existing project identity rules.
