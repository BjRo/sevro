/**
 * Kernel: pure, I/O-free building blocks shared by every layer: the result
 * contract types, value guards, canonical identity hashing, instrumentation
 * and advisory-recommendation contracts. It depends on no other Sevro module.
 */
export type {
  ArtifactReference,
  Assessment,
  CheckDeclaration,
  CheckOutcome,
  Diagnostic,
  DomainOutcome,
  EvidenceRoute,
  ExecutionStatus,
  ExitCode,
  EvaluationProgress,
  ExtensionCheckOutcome,
  GradingStatus,
  MetricEvidence,
  ObservationCompleteness,
  ObservationEvidence,
  OutcomeStatus,
  RawResultReference,
  TaskVerdict,
  UsageEvidence,
} from "./contract-types";
export {
  containsControl,
  isMissingFile,
  isOptionalNonblankString,
  isRecord,
  isStringArray,
  isUnknownArray,
  requireRecord,
  validQualifiedId,
} from "./value-guards";
export {
  canonicalJson,
  createEvaluationIdentity,
  hashJson,
  sha256,
  type IdentityDimensions,
} from "./identity";
export {
  InstrumentationEvidenceError,
  prepareInstrumentation,
  snapshotInstrumentation,
  verifyAppliedInstrumentation,
  type InstrumentationCapability,
  type InstrumentationRequest,
} from "./instrumentation";
export {
  advisoryPrompt,
  parseAdvisoryRecommendation,
  type AdvisoryRecommendation,
} from "./advisory";
