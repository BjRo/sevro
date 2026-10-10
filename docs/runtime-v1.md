# Runtime configuration v1

Configure access to existing host tools, private writable caches, native goals,
and selected plugin hooks in `<project-root>/sevro.json`. This interface is
available in `0.1.0-rc.3` and later.

`--runtime-config-file /absolute/path/runtime.json` selects a replacement file.
Sevro reads exactly one file before execution, including dry runs. It does not
merge files, search parent directories, or read a candidate's copy. An absent
default file preserves the previous isolation defaults. An absent explicit
file, malformed configuration, unsupported field, or invalid selected input
fails with exit `64` before a candidate starts. Files must be regular,
non-symlink files of at most 64 KiB.

The [JSON schema](../schemas/runtime-v1.schema.json) has format
`sevro.runtime.v1`. All properties except `format` are optional.

```json
{
  "format": "sevro.runtime.v1",
  "environment": {
    "inherit": ["PATH"],
    "set": {
      "UV_CACHE_DIR": "{{sevro.runtime}}/uv-cache",
      "DARROW_CACHE_DIR": "{{sevro.runtime}}/darrow-cache"
    }
  },
  "runtime": {
    "seedDirectories": [{ "source": "./public-uv-cache", "target": "uv-cache" }]
  },
  "hooks": {
    "nativeGoal": true,
    "plugins": ["darrow-review", "darrow-tdd"]
  }
}
```

Create the example's `public-uv-cache` directory beside the configuration, or
omit `runtime` when no prepared cache is needed. Selected plugin names must be
present in the case's prepared mounts; remove names that the case does not mount.
`DARROW_CACHE_DIR` is an ordinary explicit variable in this example, not a
Sevro-specific cache option.

## Environment and host tools

`environment.inherit` snapshots the named variables from the invoking process.
A named variable must exist. `environment.set` supplies explicit strings and
takes precedence over an inherited value. These values are retained in evidence:
declare only non-secret values. Credential names and runner-owned variables
such as `HOME`, temporary-directory variables, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
shell startup overrides, subprocess injection flags, and `UV_OFFLINE` are refused.

An inherited or explicit `PATH` must contain nonempty absolute entries. For an
inherited `PATH`, Sevro removes entries whose directory, installation prefix, or
symlinked tools overlap credential roots, including `~/.codex` and `~/.claude`.
This lets evaluations invoked from a Codex CLI session use ordinary host tools
without manually removing injected paths. Lexical paths and canonical targets
are checked, including absent credential paths. The remaining entries keep their
original order; the effective `PATH` is retained in runtime evidence. A `PATH`
with no remaining entries fails rather than selecting fallback tools.

An explicit `environment.set.PATH` remains authoritative and conflicting grants
fail, even when `PATH` is also inherited. Source and evaluator overlaps, invalid
entries, and unreadable unprotected directories remain errors for either form.
Missing unprotected entries are inert. Sevro grants read-only access to existing directories,
resolved symlinked tools, and bounded installation prefixes above `bin`.
An inaccessible individual symlink target is inert; an unreadable PATH directory
still fails configuration. Explicitly declared read roots must remain readable.
It does not widen a `bin` grant to the whole home, `/usr`, `/usr/local`, or
`/opt/homebrew`. Direct versioned mise paths can reuse their existing Node or
Python installations. A mise shim may also need explicitly declared mise data
and configuration; inheriting `PATH` does not change the shim's own discovery
rules. Fixture binaries keep precedence over declared host tools.

When `PATH` is declared, Sevro also queries available installation metadata
before execution. Homebrew's `--prefix` and `--cellar` identify its existing
`Cellar`, `opt`, and `etc` support trees on macOS and Linux. The whole Homebrew
prefix is not granted. On macOS, selected Apple tool shims (including Git,
Python, and compiler tools) use `xcode-select --print-path` to locate their
developer support tree. A declared `DEVELOPER_DIR` participates in that query;
an unrelated ambient override does not. Installation locations are not assumed.
Each query has a three-second deadline and an 8 KiB combined output limit.
Absent providers and the known no-active-Apple-installation result add no roots.
Other query failures, invalid metadata, or a missing declared developer override
fail before execution. Diagnostics identify the provider and operation without
retaining arbitrary command output.

Declare supporting directories outside `PATH` with `filesystem.readOnlyRoots`:

```json
{
  "format": "sevro.runtime.v1",
  "environment": { "inherit": ["PATH", "UV_PYTHON_INSTALL_DIR"] },
  "filesystem": { "readOnlyRoots": ["${UV_PYTHON_INSTALL_DIR}"] }
}
```

Set `UV_PYTHON_INSTALL_DIR` in the invoking environment before using this example.
Filesystem declarations resolve relative to the selected file. `~/` names the
operator's real home; `${NAME}` expands only a declared environment variable.
Existing directory paths and symlink targets are canonicalized. Reads under
the real home are allowed only through bounded runtime grants. Source and
configuration worktrees, evaluator inputs, credentials, results, run ownership
state, and peer fixtures remain protected. A conflicting or broad grant fails.

Use `filesystem.optionalReadOnlyRoots` for supporting directories that may not
be installed on every host, with the same path rules as `readOnlyRoots`:

```json
{
  "format": "sevro.runtime.v1",
  "filesystem": {
    "optionalReadOnlyRoots": [
      "../public-python-installations",
      "../public-tool-cache"
    ]
  }
}
```

With `sevro.json` at the repository root, these paths name sibling support
directories outside the protected repository. Keep them bounded to public tool
data; directories inside the repository remain protected even when absent.

Only absent directories are skipped. Invalid variables or paths, unreadable
directories, regular files, and protected overlaps remain errors. Required roots
still fail when absent. Effective roots retain both lexical directory paths and
canonical targets, and both are checked against protected inputs. Native aliases
inside granted support trees (for example, `opt/package` pointing into `Cellar`)
remain usable. Codex may canonicalize a standalone symlink-root permission under
protected home, denying its lexical lookup; declare the intended bounded parent
support tree and its target rather than relying on that standalone alias.

On Linux, Codex starts candidate commands from an empty filesystem with bounded
read mounts. Sevro keeps a normal home ancestor denied by that empty-root policy
rather than adding a native deny mount that would hide its read-only descendants.
Protected source and credential descendants remain explicitly denied, and no
home ancestor receives content access. If the operator's home lies inside a
minimal system read tree such as `/usr` or `/etc`, Sevro retains its explicit deny;
the native preflight may refuse that overlapping setup rather than expose home
contents.

## Private writable state

`runtime.seedDirectories` copies prepared public dependencies into a private
slot for each execution role. `source` uses the filesystem path rules above;
`target` is a single lowercase slot name, up to 64 characters, with letters,
digits, and hyphens. `home` and `tmp` are reserved. Targets must be unique.

Each source tree is bounded to 16,384 entries and 512 MiB. Escaping symlinks,
directory cycles, dangling links, and special files are refused. File content
and modes are fingerprinted before execution and checked during copying.
Source caches are never a writable runtime. Use prepared public caches rather
than credential-bearing homes or evaluator directories.

`{{sevro.runtime}}` in an environment value resolves to that role's writable
root. Sevro supplies private `HOME` and temporary storage and sets `UV_OFFLINE=1`
and `PYTHONDONTWRITEBYTECODE=1`. Candidate, hook, checker, semantic, and advisory
state are separate. With a runtime policy, native candidate, semantic, and
advisory roots live in a unique runner-owned host directory outside the Git
fixture. The root contains `home`, `tmp`, and declared seed slots; plugins can
use paths such as `~/.darrow/reviews` without creating repository-local review
state. Command runtime directories are separate from host authentication,
configuration, and live transcript sources. Checker and hook caches also live
outside candidate-controlled workspace state. Private roots survive native
continuation turns and children, then are removed with their owning trial or
host state after owned hooks terminate. Runs without a selected runtime policy
retain their previous writable-state locations.

Claude runtime policies refuse a private namespace overlapping the native CLI's
implicit `/tmp/claude` or `/private/tmp/claude` write roots, including canonical
symlink targets. A conflicting `TMPDIR` placement fails before native launch;
choose a temporary base outside those cache trees.

The same declared tool environment reaches native candidates, isolated shell
checks, and native semantic/advisory hosts. Candidate plugin-hook authority is
not forwarded to grading hosts. Injected adapters receive the policy as request
data and remain trusted code responsible for their own execution boundary.

## Goals and plugin hooks

`hooks.nativeGoal` enables Claude's native goal Stop-hook path while preserving
subscription/OAuth and API-key authentication. For a Codex CLI candidate it
selects `app-server` when no entrypoint was supplied. Explicit `exec` conflicts
with a native-goal policy. Programmatic Codex callers must construct an
`app-server` host. Native goal observations report actual host status; enabling
the policy does not itself prove that a goal was created or completed.

`hooks.plugins` authorizes all command hooks from the named prepared plugins.
Sevro copies immutable mounts, filters unselected hooks, and wraps selected
handlers in a credential-free macOS or Linux sandbox. It covers default hook files,
manifest path/inline declarations in both host formats, and Markdown skill or
agent frontmatter. Unsupported handler types and exec-form arguments fail
instead of being skipped. The wrapper denies network access and protected
roots and owns asynchronous hook cleanup. Native timeout/cancellation stops
owned hook descendants before private state is removed.

Auxiliary `.mcp.json` and `.lsp.json` files and plugin mods are unsupported under
hook authority. Manifest MCP/LSP declarations are removed from curated mounts.

Plugin-only settings are required when goals or custom hooks are enabled;
`--claude-project-settings` conflicts with that policy. Keep repository-skill
cases on their explicit project-settings route with hooks disabled. Unrelated
user settings and hooks are not imported. Sevro does not use Claude's `--bare`
mode, which would change authentication and behavior.

## Native transcript access

Set top-level `"nativeTranscripts": true` to enable live, read-only access to
the current role's full native root and subagent transcript tree. Absent or
`false` leaves this access and capture disabled. The selection is snapshotted
with the runtime policy and enters configuration identity; temporary native
homes and transcript views do not enter that identity. Codex `exec` persists
sessions when enabled, including runs without continuation.

Commands discover their own tree through `SEVRO_NATIVE_TRANSCRIPT_ROOT`.
Codex commands also receive runner-owned `CODEX_HOME`; native
`CODEX_THREAD_ID` selects `sessions/**/rollout-*-<thread>.jsonl`. Read the latest
native `turn_context` for that session's `model` and `effort`. Claude shell
commands receive a credential-free `CLAUDE_CONFIG_DIR` view whose `projects/`
tree contains `projects/*/<CLAUDE_CODE_SESSION_ID>.jsonl` and subagent files.
The latest native assistant `message.model` records the observed model.
Claude supplies `CLAUDE_CODE_SESSION_ID` and `CLAUDE_EFFORT` itself; Sevro does
not replace these with the root's requested route. Requested CLI effort is
configuration, and is not proof of an effective child effort. Missing native
route evidence stays unknown.

Observed with Claude Code 2.1.284: a native Agent's Bash may receive the parent's
`CLAUDE_CODE_SESSION_ID` and no `CLAUDE_EFFORT`. In that situation the environment
pair selects the parent transcript. Analyze the child's native JSONL and
`.meta.json` sidecar to establish its own model/session association; the
parent's model is not the child's observed model, and missing effort remains
unknown. Sevro preserves these native values without synthesizing a child
context or copying the root's requested effort into the child.

Native hosts keep their credential-bearing homes. Claude's host writes through
a runner-created, canonical-bound `projects` link into the isolated source;
runner-owned Bash and zsh startup files supply the shell compatibility view.
These sources and startup files sit outside candidate-writable state. Commands
cannot modify transcripts or read credential/settings siblings, evaluator
inputs, or peer role/trial state. A fixed private namespace is protected before
commands start, including peers created later. Pre-existing namespaces must be
owned private directories; links and unsafe permissions fail. Ordinary
filesystem declarations cannot authorize access to this namespace.
Namespace read roots and seed sources, including declaration symlinks into it,
are refused before private trees are hashed or copied.
On Linux, Codex keeps this namespace hidden through its empty-root policy and
mounts only runner-owned session/helper trees and retained views. It avoids an
ancestor deny mount that would mask these narrower read-only grants. Ordinary
declarations cannot select this exception; parent content, credentials, and
present or future peer state receive no grants.

After candidate execution, isolated shell checks and semantic/advisory hosts
receive `SEVRO_CANDIDATE_TRANSCRIPTS`, a separate read-only retained view with
`index.json` and `codex/` or `claude/` native relative file paths. This does not
replace a grading host's own native home or live tree. Trusted injected adapters
receive the same view through request `candidateTranscriptRoot`. The temporary
view is removed after grading; stable retained artifact references remain in
run evidence. Extensions and external benchmarks consume the
[native transcript bundles](results-v1.md#native-transcript-bundles).

## Evidence and compatibility

`configuration.redacted.runtimePolicy` retains the selected environment,
canonical read roots, seed digests, and hook declaration. The engine snapshots
this input once; it participates in `configurationDigest` and evaluation
identity. Symbolic runtime placeholders remain symbolic in identity, while
execution uses per-role paths. This binds declared setup and seed contents;
it does not claim that every external installation file or OS dependency is
immutable.

The retained policy also records metadata providers, their selected executables
and effective support roots, plus skipped optional paths. These values and the
actual effective roots enter identity; private execution paths and external tool
file contents do not. The same discovery and skip evidence reaches
`sevro.host.runtime` observations.

Bundled hosts supply `sevro.host.runtime` with the applied policy digest, role,
environment names, read roots, and seed slots. `sevro.host.hooks` records source
and effective plugin digests plus observed executions and their exit codes.
An empty execution list does not prove hook activation. Partial lifecycle
evidence remains partial. Cases can require these observations; missing required
evidence cannot become a pass. Goal and hook success remain separate from the
task verdict.

`--toolchain-bin-dir` and `--claude-uv-cache-dir` are deprecated. They keep their
previous behavior with a warning when no runtime file is selected. Combining
them with a runtime file fails before execution. Migrate to `environment`,
`filesystem`, and private seed slots; removal is no earlier than `0.2.0`.
See the [CLI reference](development-cli.md), [native hosts](native-hosts.md),
and [identity contract](identity-v1.md).

Programmatic consumers can import `RuntimeConfiguration`, `RuntimePolicy`, and
`loadRuntimeConfiguration` from `src/engine.ts`, then pass the resolved policy
to `runEvaluation` or a bundled host request. They must provide the same
protected-source declarations required by their execution route.
`loadRuntimeConfiguration` accepts those canonical protected roots as its third
argument, so provider queries themselves cannot run from protected source trees.
