use super::{
    RunError, RunResult,
    fixtures::PreparedFixture,
    options::{Candidate, CaseSource, Options},
    runtime_config::RuntimeSelection,
};
use crate::adapters::{AdapterExit, AdapterSession};
use crate::cancellation::Cancellation;
use crate::host::{HostError, HostRequest, HostResult};
use crate::native::{ClaudeHost, ClaudeOptions, CodexHost, CodexOptions, NativeHost};
use serde_json::{Value, json};
use std::num::NonZeroU64;
use std::path::PathBuf;

pub(super) struct HostContext {
    pub id: String,
    pub model: String,
    pub effort: String,
    pub configuration: Option<Value>,
    pub executable: Option<PathBuf>,
    pub capabilities: Vec<String>,
    pub agent_limit: Option<NonZeroU64>,
    session: Option<AdapterSession>,
    native: Option<NativeHost>,
    timeout_ms: Option<u64>,
    cancellation: Cancellation,
}

impl HostContext {
    pub fn open(
        options: &Options,
        agent_limit: Option<NonZeroU64>,
        cancellation: Cancellation,
    ) -> RunResult<Self> {
        match &options.candidate {
            Candidate::Codex {
                binary,
                model,
                effort,
                timeout_ms,
                ..
            } => Ok(Self {
                id: "sevro.host.codex".into(),
                model: model.clone(),
                effort: effort.clone(),
                configuration: Some(
                    json!({"sevro.codex.agent-concurrency-limit":agent_limit,"sevro.host.executable":binary}),
                ),
                executable: Some(binary.clone()),
                agent_limit,
                capabilities: [
                    "sevro.host.continuation",
                    "sevro.host.runtime",
                    "sevro.host.native-transcripts",
                    "sevro.host.hooks",
                    "sevro.host.skill-activations",
                    "sevro.codex.plugin-marketplace",
                    "sevro.codex.explicit-invocation",
                    "sevro.codex.repository-invocation",
                    "sevro.codex.native-calls",
                    "sevro.host.native-controls",
                ]
                .into_iter()
                .filter(|capability| options.dry || *capability == "sevro.host.continuation")
                .map(String::from)
                .collect(),
                session: None,
                native: None,
                timeout_ms: Some(*timeout_ms),
                cancellation,
            }),
            Candidate::Claude {
                binary,
                model,
                effort,
                ..
            } => Ok(Self {
                id: "sevro.host.claude".into(),
                model: model.clone(),
                effort: effort.clone(),
                configuration: Some(json!({"sevro.host.executable":binary})),
                agent_limit: None,
                executable: Some(binary.clone()),
                capabilities: vec![
                    "sevro.host.continuation".into(),
                    "sevro.claude.continuation".into(),
                ],
                session: None,
                native: None,
                timeout_ms: Some(600_000),
                cancellation,
            }),
            Candidate::Adapter { module } => {
                let session = AdapterSession::load(module, &cancellation)?;
                let metadata = session.metadata();
                Ok(Self {
                    id: metadata.id.clone(),
                    model: metadata.model.clone(),
                    effort: metadata.effort.clone(),
                    configuration: metadata.configuration.clone(),
                    agent_limit: None,
                    executable: None,
                    capabilities: vec![],
                    session: Some(session),
                    native: None,
                    timeout_ms: None,
                    cancellation,
                })
            }
        }
    }

    pub fn descriptor(&self) -> Value {
        json!({"id":self.id,"model":self.model,"effort":self.effort,"capabilities":self.capabilities})
    }

    pub fn prepare_execution(
        &mut self,
        options: &Options,
        fixture: &PreparedFixture,
        runtime: &RuntimeSelection,
    ) {
        if options.dry {
            return;
        }
        if matches!(options.candidate, Candidate::Adapter { .. }) {
            return;
        }
        let mut protected_roots = fixture.protected_roots();
        protected_roots.push(options.config_root.clone());
        protected_roots.push(options.run_state_root.clone());
        protected_roots.extend(runtime.path.iter().cloned());
        protected_roots.extend(options.run_manifest_file.iter().cloned());
        protected_roots.extend(options.case_source_root.iter().cloned());
        protected_roots.extend(options.case_source_map_file.iter().cloned());
        match &options.case_source {
            CaseSource::File(path) => protected_roots.push(path.clone()),
            CaseSource::Extension(selection) => {
                protected_roots.push(selection.command_file.clone());
                protected_roots.extend(selection.source_files.iter().cloned());
                protected_roots.extend(selection.configuration_file.iter().cloned());
                protected_roots.extend(selection.redacted_configuration_file.iter().cloned());
            }
        }
        self.native = match &options.candidate {
            Candidate::Codex {
                binary,
                auth_file,
                model,
                effort,
                timeout_ms,
            } => Some(NativeHost::Codex(CodexHost::new(CodexOptions {
                binary: binary.clone(),
                auth_file: auth_file.clone(),
                model: model.clone(),
                effort: effort.clone(),
                project_root: options.project_root.clone(),
                results_root: options.results_root.clone(),
                protected_roots,
                timeout_ms: *timeout_ms,
                runtime_policy: runtime.policy.clone(),
                agent_limit: self.agent_limit,
            }))),
            Candidate::Claude {
                binary,
                credential_file,
                model,
                effort,
            } => Some(NativeHost::Claude(ClaudeHost::new(ClaudeOptions {
                binary: binary.clone(),
                credential_file: credential_file.clone(),
                model: model.clone(),
                effort: effort.clone(),
                project_root: options.project_root.clone(),
                results_root: options.results_root.clone(),
                protected_roots,
            }))),
            Candidate::Adapter { .. } => None,
        };
    }

    pub fn timeout_ms(&self) -> Option<u64> {
        self.timeout_ms
    }

    pub fn cancellation(&self) -> &Cancellation {
        &self.cancellation
    }

    pub fn execute(&self, request: &HostRequest<'_>) -> Result<HostResult, HostError> {
        if let Some(native) = &self.native {
            return native
                .execute(request, &self.cancellation)
                .map_err(HostError::Failure);
        }
        self.session
            .as_ref()
            .ok_or("native execution is not yet implemented in Rust")?
            .execute(request, &self.cancellation)
    }

    pub fn shutdown(self) -> RunResult<Option<AdapterExit>> {
        self.session
            .map_or(Ok(None), AdapterSession::shutdown)
            .map_err(RunError::from)
    }
}
