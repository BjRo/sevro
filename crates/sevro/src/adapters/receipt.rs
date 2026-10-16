use crate::host::{Artifact, HostError, HostResult};
use data_encoding::BASE64;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodedArtifact {
    id: String,
    bytes: String,
}

pub(super) fn decode(mut value: Value) -> Result<HostResult, HostError> {
    if value.get("actualCondition").is_some_and(|condition| {
        !matches!(condition.as_str(), Some("unknown" | "passive" | "enforced"))
    }) {
        return Err(HostError::InvalidConditionEvidence);
    }
    let artifacts = value
        .as_object_mut()
        .ok_or("invalid adapter result")?
        .remove("artifacts")
        .map(serde_json::from_value::<Vec<EncodedArtifact>>)
        .transpose()
        .map_err(|error| format!("invalid adapter artifacts: {error}"))?
        .unwrap_or_default();
    let mut result: HostResult = serde_json::from_value(value)
        .map_err(|error| format!("invalid adapter result: {error}"))?;
    result.artifacts = artifacts
        .into_iter()
        .map(|artifact| {
            let bytes = BASE64
                .decode(artifact.bytes.as_bytes())
                .map_err(|error| format!("invalid adapter artifact bytes: {error}"))?;
            Ok(Artifact {
                id: artifact.id,
                bytes,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(result)
}
