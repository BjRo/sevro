/**
 * Claude saved-login selection and trial authentication.
 *
 * Selects the operator's saved Claude login, from its macOS Keychain item or
 * configuration file, or the inherited authentication variables, and stages a
 * trial's authentication from it. The parent alone refreshes a due login under
 * Claude Code's refresh lock, then durably rotates it or retains the rotation
 * for recovery. Trials receive only an access token, never the saved login.
 */
export {
  CLAUDE_AUTH_VARIABLES,
  CLAUDE_LOGIN_MARGIN_MS,
  stageClaudeAuthentication,
} from "./claude-credential";
