/**
 * Transcripts: retention of native host transcripts after a candidate run and
 * the read-only transcript views handed to grading.
 */
export {
  candidateTranscriptEnvironment,
  candidateTranscriptRoots,
  failedNativeTranscripts,
  retainEnabledNativeTranscripts,
} from "./native-transcripts";
export { materializeNativeTranscriptView } from "./native-transcript-view";
