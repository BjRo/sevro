import { RUN_OPTIONS, optionsWith, type RunOptionName } from "./run-options";
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
  sevro prune

Commands:
  demo      Run the packaged credential-free assessed example; use demo --help.
  init      Create a new evaluation project; use init --help.
  run       Evaluate one resolved case or extension case; use run --help.
  report    Summarize retained results; use report --help.
  prune     Remove retained results using a retention policy; use prune --help.

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
${runOptionHelp("required")}

Common options and defaults:
${runOptionHelp("common")}
  Precedence: built-in defaults, saved settings, then explicit CLI options.
  Manifest paths use its own directory; CLI paths use the current directory.
  --no-dry, --no-shell-isolation and other --no-<boolean> flags override saved true.
  Relative run paths resolve from the current directory and are canonicalized before protection checks.

Bundled hosts:
${runOptionHelp("native")}
  Native timeout defaults to 600000 ms; shell checks expect exit 0 within 30000 ms.

Extension cases:
${runOptionHelp("extension")}

Optional grading routes (none selected by default):
${runOptionHelp("grading")}

Provenance overrides (normally derived automatically):
${runOptionHelp("provenance")}

Deprecated runtime options:
${runOptionHelp("deprecated")}

  -h, --help                 Show this help without preparing a run.
Reference: docs/development-cli.md, docs/run-settings-v1.md and docs/results-v1.md in the installed package.
`;

function runOptionHelp(
  section: (typeof RUN_OPTIONS)[RunOptionName]["section"],
): string {
  return optionsWith("section", section)
    .map((name) => `  --${name} ${RUN_OPTIONS[name].help}`)
    .join("\n");
}

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

const PRUNE_HELP = `Usage: sevro prune [options]

Examples:
  sevro prune
  sevro prune --results-root ./other-results --keep 5
  sevro prune --older-than 30d
  sevro prune --latest
  sevro prune --native-transcripts --older-than 30d

Defaults: keep the newest 10 completed results under <cwd>/.sevro/results.
Select at most one explicit retention policy:
  --keep <positive-integer>  Keep this many newest results.
  --latest                   Keep only the newest result (same as --keep 1).
  --older-than <duration>    Remove results older than a positive integer plus ms, s, m, h, d or w.
  --results-root <path>      Relative or absolute results root, resolved from cwd.
  --native-transcripts       Remove only native transcript bundles; keep results and hashes.
  -h, --help                 Show help without reading or deleting results.

Age and ordering use result.json modification times; equal times sort by path.
Each retained attempt counts separately, including dry, failed and interrupted runs.
Active/unrecognized attempts and directories without result.json are preserved.
Evidence is permanently deleted. Remaining results stay usable by sevro report;
latest.json is updated, or removed when no completed results remain.
With --native-transcripts, no policy removes bundles from all completed results;
--keep/--latest preserve bundles for the newest results, and --older-than selects older results.
Result/evidence files and latest.json stay unchanged. Reports label removed bundles as pruned.
Missing or empty results roots are a successful no-op. Invalid or unreadable inputs exit 64.
Reference: docs/reading-results.md in the installed package.
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
  "prune --help": PRUNE_HELP,
  "prune -h": PRUNE_HELP,
  "help prune": PRUNE_HELP,
};

/** Handle informational commands before loading inputs or creating run state. */
export function informationCommand(argv: string[]): boolean {
  const request = argv.slice(1).some((arg) => ["--help", "-h"].includes(arg))
    ? [argv[0], "--help"].join(" ")
    : argv.join(" ");
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
