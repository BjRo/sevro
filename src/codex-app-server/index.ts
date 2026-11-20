/**
 * Codex app-server client.
 *
 * Runs one Codex execution over the app-server JSON-RPC transport: starts the
 * root thread and turns, follows native goal continuation and one declared
 * feedback turn, reads back the settled history, and reports the final
 * message with bounded transport evidence. Protocol framing, goal readback
 * and settlement rules stay inside.
 */
export {
  runCodexAppServer,
  type AppServerEvidence,
  type AppServerRunOptions,
} from "./codex-app-server";
