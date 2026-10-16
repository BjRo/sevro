mod continuation;
mod events;
mod process;
mod profile;
mod session;
mod state;

use crate::cancellation::Cancellation;
use crate::host::{Artifact, HostRequest, HostResult, ProcessFailure};
use serde_json::json;
use state::State;
use std::ffi::OsString;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::time::Duration;

pub(crate) struct CodexOptions {
    pub binary: PathBuf,
    pub auth_file: PathBuf,
    pub model: String,
    pub effort: String,
    pub project_root: PathBuf,
    pub results_root: PathBuf,
    pub protected_roots: Vec<PathBuf>,
    pub timeout_ms: u64,
}

pub(crate) struct CodexHost {
    options: CodexOptions,
}

impl CodexHost {
    pub fn new(options: CodexOptions) -> Self {
        Self { options }
    }

    pub fn execute(
        &self,
        request: &HostRequest<'_>,
        cancellation: &Cancellation,
    ) -> Result<HostResult, String> {
        if request.condition != "passive" {
            return Err("Codex enforcement instrumentation is unavailable".into());
        }
        let state = State::prepare(&self.options, request.workspace)?;
        let executed = self.execute_prepared(request, &state, cancellation);
        state.close()?;
        executed
    }

    fn execute_prepared(
        &self,
        request: &HostRequest<'_>,
        state: &State,
        cancellation: &Cancellation,
    ) -> Result<HostResult, String> {
        if let Some(failure) = self.preflight(request, state, cancellation)? {
            return Ok(failure);
        }
        let original = request
            .follow_up_prompt
            .and_then(|_| continuation::fingerprint(request.workspace));
        let output = self.turn(request, state, request.prompt, None, cancellation)?;
        if output.reason != "exit" {
            return failed_process(output, "execution", self.options.timeout_ms);
        }
        let mut summary = events::summarize(&output.stdout, output.status.success())?;
        let mut artifacts = vec![Artifact {
            id: "sevro.codex.events".into(),
            bytes: output.stdout,
        }];
        let mut observations = Vec::new();
        if let Some(prompt) = request.follow_up_prompt {
            observations.push(continuation::observation(
                request.workspace,
                &state.codex_home,
                &summary.thread_id,
                original,
            ));
            let follow_up = self.turn(
                request,
                state,
                prompt,
                Some(&summary.thread_id),
                cancellation,
            )?;
            if follow_up.reason != "exit" {
                return failed_process(follow_up, "execution", self.options.timeout_ms);
            }
            let follow_up_summary =
                events::summarize(&follow_up.stdout, follow_up.status.success())?;
            if follow_up_summary.thread_id != summary.thread_id {
                return Err("Codex follow-up turn did not complete in the original thread".into());
            }
            summary.final_message = follow_up_summary.final_message;
            summary.input_tokens = summary
                .input_tokens
                .zip(follow_up_summary.input_tokens)
                .map(|(first, second)| first + second);
            summary.output_tokens = summary
                .output_tokens
                .zip(follow_up_summary.output_tokens)
                .map(|(first, second)| first + second);
            summary.usage_complete &= follow_up_summary.usage_complete;
            artifacts.push(Artifact {
                id: "sevro.codex.follow-up-events".into(),
                bytes: follow_up.stdout,
            });
        }
        Ok(HostResult {
            complete: summary.final_message.is_some(),
            final_message: summary.final_message,
            actual_condition: Some("passive".into()),
            input_tokens: summary.input_tokens,
            output_tokens: summary.output_tokens,
            cost_usd: None,
            usage_complete: Some(summary.usage_complete),
            artifacts,
            observations,
            ..Default::default()
        })
    }

    fn turn(
        &self,
        request: &HostRequest<'_>,
        state: &State,
        prompt: &str,
        thread: Option<&str>,
        cancellation: &Cancellation,
    ) -> Result<process::Output, String> {
        let mut arguments: Vec<OsString> = vec!["exec".into()];
        if thread.is_some() {
            arguments.push("resume".into());
        }
        arguments.extend([
            "--json".into(),
            "--strict-config".into(),
            "--skip-git-repo-check".into(),
        ]);
        if request.follow_up_prompt.is_none() {
            arguments.push("--ephemeral".into());
        }
        arguments.push("--ignore-rules".into());
        if thread.is_none() {
            arguments.extend(["-C".into(), request.workspace.as_os_str().to_owned()]);
        }
        arguments.extend([
            "-m".into(),
            self.options.model.clone().into(),
            "-c".into(),
            format!(
                "model_reasoning_effort={}",
                serde_json::to_string(&self.options.effort).map_err(|error| error.to_string())?
            )
            .into(),
            "-c".into(),
            format!("default_permissions=\"{}\"", state.profile_id).into(),
            "-c".into(),
            "approval_policy=\"never\"".into(),
        ]);
        if let Some(thread) = thread {
            arguments.push(thread.into());
        }
        arguments.push("-".into());
        process::run(
            &self.options.binary,
            &arguments,
            request.workspace,
            &state.environment,
            Some(prompt.as_bytes()),
            Duration::from_millis(self.options.timeout_ms),
            cancellation,
        )
    }

    fn preflight(
        &self,
        request: &HostRequest<'_>,
        state: &State,
        cancellation: &Cancellation,
    ) -> Result<Option<HostResult>, String> {
        let probe = state.command_temp.join("isolation-probe");
        state::write_private(&probe, b"probe\n")?;
        let arguments = vec![
            "sandbox".into(), "-P".into(), state.profile_id.clone().into(),
            "-C".into(), request.workspace.as_os_str().to_owned(), "/bin/sh".into(), "-c".into(),
            "/bin/cat \"$1\" >/dev/null && ! /bin/ls \"$2\" >/dev/null 2>&1 && ! /bin/cat \"$3\" >/dev/null 2>&1 && ! /bin/cat \"$4\" >/dev/null 2>&1 || exit 70; \"$5\" --version >/dev/null 2>&1 || exit 71".into(),
            "sevro-probe".into(), probe.into_os_string(), self.options.project_root.as_os_str().to_owned(),
            state.codex_home.join("auth.json").into_os_string(), state.codex_home.join("config.toml").into_os_string(),
            self.options.binary.as_os_str().to_owned(),
        ];
        let output = process::run(
            &self.options.binary,
            &arguments,
            request.workspace,
            &state.environment,
            None,
            Duration::from_secs(60),
            cancellation,
        )?;
        if !output.status.success() {
            let phase = if output.reason == "exit" && output.status.code() == Some(71) {
                "executable-preflight"
            } else {
                "isolation-preflight"
            };
            return failed_process(output, phase, 60000).map(Some);
        }
        Ok(None)
    }
}

fn failed_process(
    output: process::Output,
    phase: &str,
    timeout_ms: u64,
) -> Result<HostResult, String> {
    let signal = output
        .status
        .signal()
        .and_then(|number| nix::sys::signal::Signal::try_from(number).ok())
        .map(|signal| signal.as_str().to_owned());
    let receipt = json!({
        "phase":phase,"reason":output.reason,"timeoutMs":timeout_ms,"code":output.status.code().or_else(|| output.status.signal().map(|signal| 128+signal)),
        "signal":signal,"durationMs":output.duration_ms,"stderrTruncated":output.stderr_truncated,
    });
    Ok(HostResult {
        execution_failed: true,
        actual_condition: Some("passive".into()),
        process_failure: Some(ProcessFailure {
            phase: phase.into(),
            reason: output.reason.into(),
            timeout_ms,
        }),
        artifacts: vec![
            Artifact {
                id: "codex.process".into(),
                bytes: serde_json::to_vec(&receipt).map_err(|error| error.to_string())?,
            },
            Artifact {
                id: "codex.stderr".into(),
                bytes: output.stderr,
            },
        ],
        ..Default::default()
    })
}
