/**
 * Codex app-server client.
 *
 * Runs one Codex execution over the app-server JSON-RPC transport: starts the
 * root thread and turns, follows native goal continuation and one declared
 * feedback turn, reads back the settled history, and reports the final
 * message, root-thread token usage and bounded transport evidence. Protocol
 * framing, goal readback, usage and settlement rules stay inside.
 */
export {
  runCodexAppServer,
  type AppServerEvidence,
  type AppServerRunOptions,
  type AppServerUsage,
} from "./codex-app-server";
