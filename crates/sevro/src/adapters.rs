mod receipt;
mod transport;

use crate::cancellation::Cancellation;
use crate::host::{HostError, HostRequest, HostResult};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Mutex;
use transport::{CancellationPhase, Transport};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Metadata {
    pub id: String,
    pub model: String,
    pub effort: String,
    pub configuration: Option<Value>,
    #[serde(default)]
    instrumentation: Vec<Value>,
    #[serde(default)]
    host_capabilities: Vec<String>,
}

pub(crate) struct AdapterSession {
    metadata: Metadata,
    transport: Mutex<Transport>,
}

pub(crate) struct AdapterExit {
    pub code: i32,
}

impl AdapterSession {
    pub fn load(module: &Path, cancellation: &Cancellation) -> Result<Self, String> {
        let mut transport = Transport::start()?;
        let metadata: Metadata = serde_json::from_value(transport.exchange_cancelable(
            &json!({"method":"load", "module":module}),
            cancellation,
            CancellationPhase::Import,
        )?)
        .map_err(|error| format!("invalid adapter metadata: {error}"))?;
        if !metadata.instrumentation.is_empty() || !metadata.host_capabilities.is_empty() {
            return Err(
                "adapter instrumentation and capabilities are not yet supported in Rust".into(),
            );
        }
        Ok(Self {
            metadata,
            transport: Mutex::new(transport),
        })
    }

    pub fn metadata(&self) -> &Metadata {
        &self.metadata
    }

    pub fn execute(
        &self,
        request: &HostRequest<'_>,
        cancellation: &Cancellation,
    ) -> Result<HostResult, HostError> {
        let result = self
            .transport
            .lock()
            .map_err(|error| error.to_string())?
            .exchange_cancelable(
                &json!({"method":"run", "request":request}),
                cancellation,
                CancellationPhase::Execution,
            )?;
        receipt::decode(result)
    }

    pub fn shutdown(self) -> Result<Option<AdapterExit>, String> {
        self.transport
            .into_inner()
            .map_err(|error| error.to_string())?
            .shutdown()
    }
}
