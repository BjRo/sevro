mod events;
mod settings;
mod state;

use super::process::{self, Flavor, Request};
use crate::cancellation::Cancellation;
use crate::host::{Artifact, HostRequest, HostResult};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) struct ClaudeOptions {
    pub binary: PathBuf,
    pub credential_file: PathBuf,
    pub model: String,
    pub effort: String,
    pub project_root: PathBuf,
    pub results_root: PathBuf,
    pub protected_roots: Vec<PathBuf>,
}

pub(crate) struct ClaudeHost {
    options: ClaudeOptions,
}

impl ClaudeHost {
    pub fn new(options: ClaudeOptions) -> Self {
        Self { options }
    }

    pub fn execute(
        &self,
        request: &HostRequest<'_>,
        cancellation: &Cancellation,
    ) -> Result<HostResult, String> {
        if request.condition != "passive" || request.follow_up_prompt.is_some() {
            return Err(
                "this Claude host does not support the requested condition or continuation".into(),
            );
        }
        require_sandbox()?;
        let state = state::State::prepare(&self.options, request.workspace)?;
        let result = self.run(request, cancellation, &state);
        state.close()?;
        result
    }

    fn run(
        &self,
        request: &HostRequest<'_>,
        cancellation: &Cancellation,
        state: &state::State,
    ) -> Result<HostResult, String> {
        let arguments: Vec<OsString> = [
            "-p",
            request.prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            &self.options.model,
            "--effort",
            &self.options.effort,
            "--permission-mode",
            "dontAsk",
            "--tools",
            "Bash,Read,Edit,Skill,Agent",
            "--setting-sources",
            "",
            "--settings",
        ]
        .into_iter()
        .map(OsString::from)
        .chain([state.settings.clone().into_os_string()])
        .chain(
            [
                "--strict-mcp-config",
                "--mcp-config",
                "{\"mcpServers\":{}}",
                "--no-chrome",
            ]
            .into_iter()
            .map(OsString::from),
        )
        .collect();
        let output = process::run(
            Request {
                binary: &self.options.binary,
                arguments: &arguments,
                cwd: request.workspace,
                environment: &state.environment,
                input: None,
                timeout: Duration::from_millis(600_000),
                cancellation,
            },
            Flavor::Claude,
        )?;
        let mut result = events::summarize(
            &output.stdout,
            output.status.success() && output.reason == "exit",
        );
        result.actual_condition = Some("passive".into());
        result.execution_failed = !result.complete;
        result.artifacts.push(Artifact {
            id: "sevro.claude.events".into(),
            bytes: output.stdout,
        });
        Ok(result)
    }
}

fn require_sandbox() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let binaries = ["/usr/bin/sandbox-exec"].as_slice();
    #[cfg(target_os = "linux")]
    let binaries = ["/usr/bin/bwrap", "/usr/bin/socat"].as_slice();
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let binaries: &[&str] = &[];
    if binaries.is_empty() || binaries.iter().any(|binary| !Path::new(binary).exists()) {
        return Err("Claude native sandbox is unavailable".into());
    }
    Ok(())
}
