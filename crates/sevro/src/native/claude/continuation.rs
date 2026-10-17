use super::{events, retain_stderr};
use crate::host::{Artifact, HostResult, Observation, ObservationCompleteness};
use crate::native::{process::Output, workspace_fingerprint::fingerprint};
use serde_json::{Value, json};
use std::path::Path;
use uuid::Uuid;

pub(super) fn run(
    workspace: &Path,
    prompt: &str,
    follow_up: &str,
    mut turn: impl FnMut(&str, &str, &str) -> Result<Output, String>,
) -> Result<HostResult, String> {
    let session = Uuid::new_v4().to_string();
    let original = fingerprint(workspace);
    let initial = turn(prompt, "--session-id", &session)?;
    let initial_bound = bound_result(&initial.stdout, &session);
    let initial_complete = events::summarize(&initial.stdout, succeeded(&initial)).complete;
    if !initial_complete || !initial_bound {
        let mut result = receipt(
            initial.stdout,
            initial_complete && initial_bound,
            initial_bound,
        );
        retain_stderr(&mut result, initial.stderr);
        return Ok(result);
    }
    let unchanged = original
        .zip(fingerprint(workspace))
        .map(|(before, after)| before == after);
    let resumed = turn(follow_up, "--resume", &session)?;
    let bound = bound_result(&resumed.stdout, &session);
    let complete = bound && events::summarize(&resumed.stdout, succeeded(&resumed)).complete;
    let combined = combine(&initial.stdout, &resumed.stdout, 8 * 1024 * 1024)?;
    let stderr = combine_stderr(&initial.stderr, &resumed.stderr)?;
    let mut result = receipt(combined, complete, bound);
    result.artifacts.extend([
        Artifact {
            id: "sevro.claude.initial-events".into(),
            bytes: initial.stdout,
        },
        Artifact {
            id: "sevro.claude.follow-up-events".into(),
            bytes: resumed.stdout,
        },
    ]);
    retain_stderr(&mut result, stderr);
    result.observations.push(Observation {
        id: "sevro.claude.continuation".into(),
        completeness: if complete && unchanged.is_some() {
            ObservationCompleteness::Complete
        } else {
            ObservationCompleteness::Partial
        },
        data: [
            ("method".into(), json!("same_session_resume")),
            ("sessionId".into(), json!(session)),
            ("preFollowUpWorktreeUnchanged".into(), json!(unchanged)),
        ]
        .into_iter()
        .collect(),
    });
    Ok(result)
}

fn succeeded(output: &Output) -> bool {
    output.status.success() && output.reason == "exit"
}

fn receipt(stdout: Vec<u8>, complete: bool, bound: bool) -> HostResult {
    let mut result = events::summarize(&stdout, complete);
    result.actual_condition = Some("passive".into());
    result.execution_failed = !result.complete;
    if !bound {
        result.input_tokens = None;
        result.output_tokens = None;
        result.cost_usd = None;
        result.usage_complete = Some(false);
    }
    result.artifacts.push(Artifact {
        id: "sevro.claude.events".into(),
        bytes: stdout,
    });
    result
}

fn bound_result(stream: &[u8], session: &str) -> bool {
    let mut results = 0;
    for line in String::from_utf8_lossy(stream)
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        if event.get("type").and_then(Value::as_str) == Some("result") {
            results += 1;
            if event.get("session_id").and_then(Value::as_str) != Some(session) {
                return false;
            }
        }
    }
    results == 1
}

fn combine(initial: &[u8], resumed: &[u8], limit: usize) -> Result<Vec<u8>, String> {
    let first = String::from_utf8_lossy(initial);
    let second = String::from_utf8_lossy(resumed);
    let combined = format!("{}\n{}", first.trim_end(), second.trim_start());
    if combined.len() > limit {
        return Err("Claude combined process output exceeds its limit".into());
    }
    Ok(combined.into_bytes())
}

fn combine_stderr(initial: &[u8], resumed: &[u8]) -> Result<Vec<u8>, String> {
    let first = String::from_utf8_lossy(initial);
    let second = String::from_utf8_lossy(resumed);
    let combined = [first.trim_end(), second.trim_start()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if combined.len() > 64 * 1024 {
        return Err("Claude combined process output exceeds its limit".into());
    }
    Ok(combined.into_bytes())
}
