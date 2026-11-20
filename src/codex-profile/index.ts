/**
 * Codex TOML policy renderer over the isolation module's validated policy.
 * Native permission precedence, platform baselines, command environment
 * encoding, and profile identifiers stay inside this feature module.
 */
export { codexPermissionProfile } from "./codex-profile";
