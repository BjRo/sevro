# Run native model hosts

The basic tutorial needs none of this setup. Bundled model routes and isolated
shell checks require macOS `sandbox-exec` or Linux `bubblewrap` (and `socat` for
Claude Code), a supported native CLI, and model
authentication. Complete commands/rules live in the [CLI reference](development-cli.md)
and [Codex host reference](codex-host.md).

## Codex

Select `--host codex`, absolute `--codex-bin` and `--codex-auth-file` paths,
and the desired model/effort. Sevro prepares an isolated host environment.
Keep authentication private and outside candidate/evaluator-visible inputs.
The default entrypoint is `exec`; app-server selection and native-goal
observations require `rc.2` or later. Unsupported instrumentation is refused.

## Claude Code

Select `--host claude`, an absolute `--claude-bin`, and the desired model/effort.
The route supports passive candidate turns. Explicit `--claude-credential-file`
takes precedence. Otherwise this checkout forwards inherited API/OAuth
credentials, then tries a saved credential file and macOS Keychain.
These improvements require `rc.3` or later; check the exact installed
release before relying on them.

Repository skill mounts under `.claude/skills` require explicit
`--claude-project-settings`; otherwise repository dispatch is refused before
launch. The bundled route disables hooks by default and omits candidate Write
access. [Runtime configuration](runtime-v1.md) enables native goals and selected
plugin hooks and reuses declared host tools with private caches. These changes
require `rc.3` or later. The CLI reference covers credential scrubbing
and follow-ups.

## Keep sources and credentials separate

Declare source/private roots as documented. Never put credentials in prompts,
argv, redacted configuration, or public evidence. Injected adapters are trusted
code and must implement their execution contract. A synthetic native packaging
fixture proves packaging behavior, not a successful authenticated model trial.
