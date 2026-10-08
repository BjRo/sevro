# Create cases and extensions

Start with a direct case for a prompt, fixture, and built-in success criteria.
Copy [the basic graded case](../examples/basic/graded.json), give it a stable
ID, and replace the prompt/check. Read [built-in graders](builtin-graders-v1.md)
for regex, JSON, and bounded schema assertions. No criteria means `not_assessed`.

Run it with the [CLI](running-evaluations.md). Direct cases follow `ResolvedCase`
in [the engine](../src/engine.ts). Fixtures can provide inline files, generated
Git history, or a declared clean repository. The [CLI reference](development-cli.md)
owns required source roots/maps; an arbitrary returned path does not grant access.

## Evaluate your repository skills

Start with one representative task, your actual skill, and observable success
criteria. This example evaluates a documentation guide's answer with Codex.
Use [Sevro from `PATH`](installing.md#make-the-command-available).
Live runs require the [native host prerequisites](native-hosts.md), macOS
isolation, an authenticated Codex installation, and your chosen model.
They consume that account's model quota.

Create this layout, keeping evaluator inputs outside the participant fixture:

```text
skill-evals/
├── cases/
│   └── explain-startup.json
├── sources.json
└── fixture-repo/
    ├── README.md
    └── .agents/skills/my-guide/
        └── SKILL.md
```

Copy your guide skill and any supporting resources into `fixture-repo`. Use
its real name in place of `my-guide`. For this sample task, write a README
that explains that `bun run dev` starts the application on port `3000`.
Initialize and commit the fixture repository, leaving it clean. Sevro clones
that committed revision into a fresh workspace for every trial.
`--project-root` alone does not copy your project into the participant workspace.

Save this case as `cases/explain-startup.json`:

```json
{
  "id": "my-guide-explain-startup",
  "prompt": "How do I start this application locally, and which port does it use?",
  "fixture": { "sourceRef": "fixture-repo" },
  "checks": [
    {
      "id": "startup-command",
      "grader": "sevro.regex",
      "configuration": { "pattern": "bun run dev" }
    },
    {
      "id": "correct-port",
      "grader": "sevro.regex",
      "configuration": { "pattern": "\\b3000\\b" }
    }
  ],
  "requiredEvidence": []
}
```

Save the source map as `sources.json`, replacing the example absolute path
with the location of your fixture repository:

```json
{
  "fixture-repo": "file:///absolute/path/skill-evals/fixture-repo"
}
```

From `skill-evals`, run the case with your actual model identifier in place
of `<codex-model>`:

```sh
sevro run --json \
  --case-file "$PWD/cases/explain-startup.json" \
  --case-source-root "$PWD" \
  --case-source-map-file "$PWD/sources.json" \
  --project-root "$PWD/fixture-repo" \
  --results-root "$PWD/results" \
  --host codex \
  --codex-bin "$(command -v codex)" \
  --codex-auth-file "${CODEX_HOME:-$HOME/.codex}/auth.json" \
  --model <codex-model> --effort medium \
  --condition passive --trials 3 --threshold 1 > result.json
```

Add `--dry` first to validate preparation without calling the model. Three
executed trials assess consistency; threshold `1` requires all three to pass.
Summarize the retained result:

```sh
sevro report --result-file "$PWD/result.json"
```

These regex checks assess answer content; they do not prove that the guide was
selected or that every claim was correct. Add cases for ordinary selection,
unrelated requests, missing inputs, follow-ups, and skill-specific boundaries.
For coding skills, use `sevro.shell` to run evaluator-owned tests against the
resulting workspace, with the required `--shell-isolation` configuration.
`sevro.semantic` can assess qualitative requirements through a separate judge.
The [grader reference](builtin-graders-v1.md) defines their limits.

To grade skill selection or verify explicit invocation, use an extension that
prepares skill mounts and interprets complete native host evidence. The
[extension protocol](extension-protocol-v1.md) defines repository and plugin
invocations; the checkout's [guide evals](guide-evaluation.md) demonstrate the
approach. Check those capabilities against your exact installed release:
this checkout contains [changes beyond published `rc.2`](installing.md#published-package-and-checkout).

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
