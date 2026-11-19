/**
 * Schema: the public wire types of CLI results, retained run evidence and
 * reports, with assertions, the extension protocol envelope check and the
 * runtime configuration schema check backed by the generated validators,
 * which stay private to this module.
 */
export {
  assertCliResult,
  assertReport,
  assertRunEvidence,
  runtimeConfigurationIssue,
  validExtensionExchange,
} from "./schema";
export type {
  AdvisoryReviewData,
  CliResultData,
  CliResultDataCase,
  CliResultDataTrial,
  ReportData,
  RunEvidenceData,
  RunEvidenceDataTrialEvidence,
} from "./schema-types";
