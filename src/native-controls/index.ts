/**
 * Native control observations.
 *
 * Derives the bounded native-controls observation from one host execution:
 * Codex native calls and Code Mode exec submissions read from the native
 * session files, and Claude control calls read from its event stream. Session
 * discovery, exec source inspection and payload bounds stay inside.
 */
export {
  codexNativeCallObservation,
  codexNativeSessionLastOrdinal,
} from "./codex-native-calls";
export {
  claudeNativeControls,
  codexNativeControls,
  type NativeControlObservation,
} from "./native-controls";
