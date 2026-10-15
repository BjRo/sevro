import { version } from "../../package.json";

const TOP_LEVEL_HELP = `Usage: sevro <command> [options]

Examples:
  sevro demo
  sevro init --template response --directory ./my-evaluation
  sevro run --case-file /absolute/case.json --adapter-module /absolute/adapter.ts \\
    --project-root /absolute/project --results-root /absolute/results \\
    --condition passive --trials 1 --threshold 1
  sevro run --help
  sevro report --result-file /absolute/results/run/result.json

Commands:
  demo      Run the packaged credential-free assessed example; use demo --help.
  init      Create a new evaluation project; use init --help.
  run       Evaluate one resolved case or extension case; use run --help.
  report    Summarize retained results; use report --help.

Options:
  -h, --help     Show help without preparing a run.
  -v, --version  Print the installed Sevro package version.
`;

const RUN_HELP = `Usage: sevro run [options]

Examples:
  sevro run --case-file /absolute/case.json --adapter-module /absolute/adapter.ts \\
    --project-root /absolute/project --results-root /absolute/results \\
    --condition passive --trials 1 --threshold 1
  Add --dry to prepare without calling the candidate or graders.
  Add --json to save a sevro.cli-result.v1 result from stdout.

Required:
  --case-file <path> OR --extension-command-file <path>  Select one case source.
  --adapter-module <path> OR --host <codex|claude>      Select one candidate route.

Common options and defaults:
  --run-manifest-file <path>  Saved sevro.run.v1 settings; explicit flags override them.
  Precedence: built-in defaults, saved settings, then explicit CLI options.
  Manifest paths use its own directory; CLI paths use the current directory.
  --no-dry, --no-shell-isolation and other --no-<boolean> flags override saved true.
  --project-root <path> (default: current directory)  Project identity; does not copy its files into the fixture.
  --results-root <path> (default: <project-root>/.sevro/results)  Retained evidence.
  --condition <passive|enforced> (default: passive)  Bundled hosts use passive.
  --trials <integer> (default: 1)  Positive number of trials.
  --threshold <number> (default: 1)  All assessed trials must pass; range (0, 1].
  Relative run paths resolve from the current directory and are canonicalized before protection checks.
  --jobs <integer> (default: 3)  Maximum parallel trials, positive integer.
  --config-root <path> (default: --project-root)  Native concurrency configuration.
  --run-state-root <path> (default: --results-root)  Active records/checkpoints.
  --runtime-config-file <path>  Runtime policy; otherwise discover project sevro.json.
  --dry                       Prepare only (default: false).
  --json                      One versioned JSON result on stdout (default: false).
                              Human diagnostics go to stderr in both modes.
  --retain-host-diagnostics   Retain private native diagnostics (default: false).
  --shell-isolation          Isolate shell checks (default: false).
  --protected-root <path>    Extra protected source/private root; repeatable.

Bundled hosts:
  --model <name> --effort <level>  Required for a bundled candidate host.
  --codex-bin <path> (default: codex on PATH)  Explicit binary override.
  --codex-auth-file <path>     Required for every Codex route.
  --codex-entrypoint <exec|app-server>  Candidate transport (default: exec).
  --codex-timeout-ms <integer>  1..1800000 milliseconds (default: 600000).
  --claude-bin <path> (default: claude on PATH)  Explicit binary override.
  Native timeout defaults to 600000 ms; shell checks expect exit 0 within 30000 ms.
  --claude-credential-file <path>  Optional credential override; otherwise use native auth.
  --claude-project-settings   Allow fixture project settings (default: false).

Extension cases:
  --case-id <id>              Required with --extension-command-file.
  --extension-source-file <path>  Required source closure; repeatable.
  --extension-configuration-file <path>  Private JSON object; supply with
  --extension-redacted-configuration-file <path>  Redacted retained configuration.
  --task-verdict-policy <id>  Select an advertised namespaced extension policy.
  --replace-builtin-grader <id>  Explicit replacement; repeatable.
  --case-source-root <path> --case-source-map-file <path>  Supply both for mapped sources.

Optional grading routes (none selected by default):
  --semantic-adapter-module <path> OR --semantic-host codex
  --semantic-model <name> --semantic-effort <level>  Required for native semantic route.
  --advisory-adapter-module <path> OR --advisory-host codex
  --advisory-model <name> --advisory-effort <level>  Required for native advisory route.
  --advisory-exclude <relative-path>  Exclude an evaluator path; repeatable.

Provenance overrides (normally derived automatically):
  --runner-build-digest <sha256> --project-digest <sha256>  64 lowercase hex characters.
  --runner-checkout-root <path>  Record the running checkout's revision/dirty digest.

Deprecated runtime options:
  --toolchain-bin-dir <path> --claude-uv-cache-dir <path>
  Migrate to sevro.json; these cannot be combined with a runtime policy.

  -h, --help                 Show this help without preparing a run.
Reference: docs/development-cli.md, docs/run-settings-v1.md and docs/results-v1.md in the installed package.
`;

const DEMO_HELP = `Usage: sevro demo [--json]

Examples:
  sevro demo
  sevro demo --json

Run the packaged deterministic fixture and adapter without model credentials.
Shows an assessed verdict and retains evidence in .sevro/results beneath the current directory.
Caller project files, sevro.json and native configuration are not loaded.

Options:
  --json       Emit one sevro.cli-result.v1 document on stdout.
  -h, --help   Show this help without preparing a run.
`;

const REPORT_HELP = `Usage: sevro report [options]

Examples:
  sevro report --latest
  sevro report --result-file /absolute/results/run/result.json
  sevro report --result-file /absolute/results/first/result.json \\
    --result-file /absolute/results/second/result.json --json

Required:
  --latest OR --result-file <path>  A retained result; repeat paths for distinct runs.
                       Relative or absolute paths use the current directory.
                       Keep each result's referenced evidence available and unchanged.

Options and defaults:
  --latest     Read the last retained CLI result, including dry or failed runs.
  --results-root <path>  With --latest, override <cwd>/.sevro/results.
  --json       Emit sevro.report.v1 JSON; Markdown by default.
  -h, --help   Show this help without reading result files.
`;

const INIT_HELP = `Usage: sevro init [options]

Examples:
  sevro init --template response --directory ./my-evaluation
  cd my-evaluation
  sevro run --run-manifest-file run.json --dry
  sevro run --run-manifest-file run.json
  sevro report --latest

Options and defaults:
  --template <response|repository-skill|coding>  Default: response.
  --directory <new-path>  Default: ./sevro-evaluation; refuses existing paths.
  -h, --help  Show this help without creating files.

Response and coding use deterministic adapters and real assertions, including negative controls.
Coding checks need sandbox-exec (macOS) or bubblewrap/socat (Linux).
Repository-skill uses native Codex and requires explicit --model, --effort and --codex-auth-file.
Read the generated README.md for prerequisites and live commands; dry preparation is not an assessment.
Reference: docs/evaluation-workflow.md in the installed package.
`;

const HELP_REQUESTS: Record<string, string> = {
  "": TOP_LEVEL_HELP,
  "--help": TOP_LEVEL_HELP,
  "-h": TOP_LEVEL_HELP,
  help: TOP_LEVEL_HELP,
  "run --help": RUN_HELP,
  "run -h": RUN_HELP,
  "help run": RUN_HELP,
  "demo --help": DEMO_HELP,
  "demo -h": DEMO_HELP,
  "help demo": DEMO_HELP,
  "init --help": INIT_HELP,
  "init -h": INIT_HELP,
  "help init": INIT_HELP,
  "report --help": REPORT_HELP,
  "report -h": REPORT_HELP,
  "help report": REPORT_HELP,
};

/** Handle informational commands before loading inputs or creating run state. */
export function informationCommand(argv: string[]): boolean {
  const request = argv.join(" ");
  if (["--version", "-v"].includes(request)) {
    process.stdout.write(`sevro ${version}\n`);
    return true;
  }
  const help = Object.hasOwn(HELP_REQUESTS, request)
    ? HELP_REQUESTS[request]
    : undefined;
  if (help === undefined) return false;
  process.stdout.write(help);
  return true;
}
