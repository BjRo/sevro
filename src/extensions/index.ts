/**
 * Extensions: a negotiated session with a trusted extension command that
 * resolves, prepares and evaluates cases over the v1 protocol. Each call runs
 * in a fresh process; transport, validation and source pinning stay inside.
 */
export {
  ExtensionSourceChangedError,
  openExtensionSession,
  type EvaluationRequest,
  type EvaluationResult,
  type ExtensionCase,
  type PreparationResult,
} from "./extension-session";
