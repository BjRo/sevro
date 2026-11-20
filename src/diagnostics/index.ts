/**
 * Diagnostics: opt-in host diagnostics that capture bounded, redacted process
 * output and persist it beside trial evidence without affecting assessment.
 */
export {
  cleanupNativeState,
  createHostDiagnostics,
  diagnoseHostRequest,
  diagnosticConfiguration,
  HostDiagnosticPersistenceError,
  HostProcessDiagnostics,
  rethrowDiagnosticPersistenceError,
  type HostDiagnostics,
} from "./host-diagnostics";
export { redactDiagnosticText } from "./host-diagnostic-redaction";
