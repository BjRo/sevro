/**
 * Codex command permission profile.
 *
 * Renders the runner-owned Codex configuration that confines model-issued
 * commands: a default-deny filesystem policy with the workspace, command home
 * and temporary directory writable, declared executable, plugin, runtime and
 * native roots readable, protected roots denied, and a credential-free command
 * environment. It refuses relative or unbounded roots, missing protection and
 * control characters before any policy text exists. Path normalization,
 * platform read baselines and TOML encoding stay inside.
 */
export { codexPermissionProfile } from "./codex-profile";
