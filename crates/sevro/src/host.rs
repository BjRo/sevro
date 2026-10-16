use serde::{Deserialize, Serialize};
use std::path::Path;

pub(crate) enum HostError {
    Failure(String),
    InvalidConditionEvidence,
}

impl From<String> for HostError {
    fn from(message: String) -> Self {
        Self::Failure(message)
    }
}

impl From<&str> for HostError {
    fn from(message: &str) -> Self {
        Self::Failure(message.into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostRequest<'a> {
    pub prompt: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follow_up_prompt: Option<&'a str>,
    pub workspace: &'a Path,
    pub condition: &'a str,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostResult {
    pub final_message: Option<String>,
    pub complete: bool,
    pub actual_condition: Option<String>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cost_usd: Option<f64>,
    pub usage_complete: Option<bool>,
    #[serde(skip)]
    pub artifacts: Vec<Artifact>,
    #[serde(skip)]
    pub observations: Vec<Observation>,
    #[serde(default)]
    pub execution_failed: bool,
    pub failure_message: Option<String>,
    #[serde(skip)]
    pub process_failure: Option<ProcessFailure>,
}

pub(crate) struct ProcessFailure {
    pub phase: String,
    pub reason: String,
    pub timeout_ms: u64,
}

pub(crate) struct Artifact {
    pub id: String,
    pub bytes: Vec<u8>,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ObservationCompleteness {
    Complete,
    Partial,
    Unavailable,
}

pub(crate) struct Observation {
    pub id: String,
    pub completeness: ObservationCompleteness,
    pub data: serde_json::Map<String, serde_json::Value>,
}
