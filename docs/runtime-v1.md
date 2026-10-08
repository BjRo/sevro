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

An inherited or explicit `PATH` must contain nonempty absolute entries. Missing
entries are inert. Sevro grants read-only access to existing directories,
resolved symlinked tools, and bounded installation prefixes above `bin`.
It does not widen a `bin` grant to the whole home, `/usr`, `/usr/local`, or
`/opt/homebrew`. Direct versioned mise paths can reuse their existing Node or
Python installations. A mise shim may also need explicitly declared mise data
and configuration; inheriting `PATH` does not change the shim's own discovery
rules. Fixture binaries keep precedence over declared host tools.

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
state are separate. Checker and hook caches live outside candidate-controlled
workspace state. Writable caches stay outside assessed worktree contents.
They are removed with their owning trial or host state.

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
handlers in a credential-free macOS sandbox. It covers default hook files,
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

## Evidence and compatibility

`configuration.redacted.runtimePolicy` retains the selected environment,
canonical read roots, seed digests, and hook declaration. The engine snapshots
this input once; it participates in `configurationDigest` and evaluation
identity. Symbolic runtime placeholders remain symbolic in identity, while
execution uses per-role paths. This binds declared setup and seed contents;
it does not claim that every external installation file or OS dependency is
immutable.

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
