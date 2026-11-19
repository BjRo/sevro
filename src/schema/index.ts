/**
 * Schema: the public wire types of CLI results, retained run evidence and
 * reports, with assertions and the extension protocol envelope check backed by
 * the generated validators, which stay private to this module.
 */
export {
  assertCliResult,
  assertReport,
  assertRunEvidence,
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
