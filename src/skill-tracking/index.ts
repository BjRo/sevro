/**
 * Passive skill-read tracking.
 *
 * A silent hook observer records which prepared skill bodies tool results
 * returned. Its receipts become the skill tracking observation and the derived
 * activation and exposure claims. Catalog discovery, receipt matching and the
 * hook handler stay inside.
 */
export { codexSkillCatalogRoots } from "./skill-hook-catalog";
export {
  prepareSkillTracking,
  skillActivationClaims,
  skillExposureClaims,
  skillTrackingObservation,
  type SkillTracking,
} from "./skill-hooks";
