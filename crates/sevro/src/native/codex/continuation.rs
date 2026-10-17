pub(super) use super::super::workspace_fingerprint::fingerprint;
use super::session;
use crate::host::{Observation, ObservationCompleteness};
use serde_json::json;
use std::path::Path;

pub(super) fn observation(
    workspace: &Path,
    codex_home: &Path,
    thread_id: &str,
    original: Option<String>,
) -> Observation {
    let unchanged = original
        .zip(fingerprint(workspace))
        .map(|(before, after)| before == after);
    Observation {
        id: "sevro.codex.continuation".into(),
        completeness: if unchanged.is_some() {
            ObservationCompleteness::Complete
        } else {
            ObservationCompleteness::Partial
        },
        data: [
            ("method".into(), json!("same_thread_resume")),
            ("threadId".into(), json!(thread_id)),
            (
                "nativeAfterOrdinal".into(),
                json!(session::last_ordinal(codex_home, thread_id)),
            ),
            ("preFollowUpWorktreeUnchanged".into(), json!(unchanged)),
        ]
        .into_iter()
        .collect(),
    }
}
