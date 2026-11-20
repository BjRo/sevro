/**
 * Bounded trial evidence.
 *
 * Callers validate host observations and artifacts, normalize optional usage,
 * and retain one trial's private files through a writer that returns the
 * persisted trial summary or a typed persistence failure. Filenames, hashes and
 * retained-byte verification stay inside.
 */
export { hostArtifacts, hostObservations } from "./host-results";
export {
  TrialEvidenceWriter,
  TrialPersistenceError,
  type TrialObservation,
  type TrialSummary,
} from "./trial-writer";
export { usage } from "./usage";
