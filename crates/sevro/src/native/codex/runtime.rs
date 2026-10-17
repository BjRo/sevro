use super::super::isolation::private_directory;
use crate::host::{Observation, ObservationCompleteness};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The configuration loader currently accepts only the empty runtime declaration.
/// Its normalized snapshot reaches this host unchanged; nonempty policies remain
/// refused before preparation until their execution effects are implemented.
pub(super) struct EmptyRuntime {
    pub home: PathBuf,
    pub temp: PathBuf,
    policy: Value,
    policy_digest: String,
}

impl EmptyRuntime {
    pub const ENVIRONMENT: [(&str, &str); 2] =
        [("UV_OFFLINE", "1"), ("PYTHONDONTWRITEBYTECODE", "1")];

    pub fn prepare(policy: &Value, state_root: &Path) -> Result<Self, String> {
        let policy_digest = format!(
            "{:x}",
            Sha256::digest(serde_jcs::to_vec(policy).map_err(|error| error.to_string())?)
        );
        let root = state_root.join("runtime");
        private_directory(&root)?;
        let home = root.join("home");
        let temp = root.join("tmp");
        private_directory(&home)?;
        private_directory(&temp)?;
        Ok(Self {
            home,
            temp,
            policy: policy.clone(),
            policy_digest,
        })
    }

    pub fn observation(&self) -> Observation {
        Observation {
            id: "sevro.host.runtime".into(),
            completeness: ObservationCompleteness::Complete,
            data: [
                ("method".into(), json!("runner_configuration")),
                ("role".into(), json!("candidate")),
                ("policyDigest".into(), json!(self.policy_digest)),
                // Runner defaults are applied, but none were declared by the caller.
                ("environmentNames".into(), json!([])),
                ("readOnlyRoots".into(), self.policy["readOnlyRoots"].clone()),
                ("discovery".into(), self.policy["discovery"].clone()),
                (
                    "skippedOptionalReadOnlyRoots".into(),
                    self.policy["skippedOptionalReadOnlyRoots"].clone(),
                ),
                ("seeds".into(), self.policy["seeds"].clone()),
            ]
            .into_iter()
            .collect(),
        }
    }
}
