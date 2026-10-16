use super::super::{RunError, RunResult, storage};
use crate::cancellation::Cancellation;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::run) struct FixtureSetupInput {
    command: Vec<String>,
    #[serde(default)]
    environment: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::run) struct FixtureSetup {
    command: Vec<String>,
    #[serde(default)]
    environment: BTreeMap<String, String>,
}

#[derive(PartialEq)]
pub(super) enum Outcome {
    Completed,
    Cancelled,
}

impl FixtureSetup {
    pub fn prepare(input: FixtureSetupInput) -> RunResult<Self> {
        let setup = Self {
            command: input.command,
            environment: input.environment,
        };
        if setup.command.is_empty()
            || setup.command.len() > 16
            || setup
                .command
                .iter()
                .any(|argument| argument.is_empty() || argument.contains('\0'))
            || !Path::new(&setup.command[0]).is_absolute()
            || setup.command.join("\0").len() > 64 * 1024
        {
            return Err("invalid fixture setup command".into());
        }
        if setup.environment.len() > 32
            || setup
                .environment
                .iter()
                .any(|(name, value)| !valid_environment(name, value))
            || serde_json::to_vec(&setup.environment)
                .map_err(|error| RunError::with_source("invalid fixture setup environment", error))?
                .len()
                > 16 * 1024
        {
            return Err("invalid fixture setup environment".into());
        }
        Ok(setup)
    }

    pub(super) fn run(
        &self,
        workspace: &Path,
        project_root: &Path,
        cancellation: &Cancellation,
    ) -> RunResult<Outcome> {
        if cancellation.is_cancelled() {
            return Ok(Outcome::Cancelled);
        }
        let home = SetupHome::new()?;
        let workspace_text = workspace.to_str().ok_or("fixture path is not UTF-8")?;
        let project_text = project_root.to_str().ok_or("project root is not UTF-8")?;
        let environment = self.environment.iter().map(|(name, value)| {
            (
                name,
                value
                    .replace("{{sevro.project}}", project_text)
                    .replace("{{sevro.workspace}}", workspace_text),
            )
        });
        let mut process = Command::new(&self.command[0])
            .args(&self.command[1..])
            .current_dir(workspace)
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
            )
            .env(
                "LANG",
                std::env::var_os("LANG").unwrap_or_else(|| "C".into()),
            )
            .env("HOME", &home.0)
            .env("TMPDIR", &home.0)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", "Sevro Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@sevro.invalid")
            .env("GIT_COMMITTER_NAME", "Sevro Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@sevro.invalid")
            .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00+00:00")
            .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00+00:00")
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|error| RunError::with_source("could not start fixture setup", error))?;
        let result = wait(&mut process, cancellation);
        if !matches!(result, Ok(Outcome::Completed)) {
            stop(&mut process);
        }
        result
    }
}

fn valid_environment(name: &str, value: &str) -> bool {
    !matches!(
        name,
        "PATH"
            | "HOME"
            | "TMPDIR"
            | "GIT_CONFIG_GLOBAL"
            | "GIT_CONFIG_NOSYSTEM"
            | "GIT_TERMINAL_PROMPT"
    ) && name.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
        && name
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && !value.contains('\0')
        && value.match_indices("{{").all(|(position, _)| {
            let suffix = &value[position..];
            suffix.starts_with("{{sevro.project}}") || suffix.starts_with("{{sevro.workspace}}")
        })
}

struct SetupHome(PathBuf);

impl SetupHome {
    fn new() -> RunResult<Self> {
        let path = std::env::temp_dir().join(format!("sevro-setup-{}", Uuid::new_v4()));
        storage::new_directory(&path)?;
        Ok(Self(path))
    }
}

impl Drop for SetupHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn wait(process: &mut Child, cancellation: &Cancellation) -> RunResult<Outcome> {
    let started = Instant::now();
    loop {
        if cancellation.is_cancelled() {
            return Ok(Outcome::Cancelled);
        }
        if let Some(status) = process
            .try_wait()
            .map_err(|error| RunError::with_source("fixture setup wait failed", error))?
        {
            return if status.success() {
                Ok(Outcome::Completed)
            } else {
                Err(format!("fixture setup failed ({})", status.code().unwrap_or(-1)).into())
            };
        }
        if started.elapsed() >= Duration::from_secs(120) {
            return Err("fixture setup timed out".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn stop(process: &mut Child) {
    let _ = killpg(Pid::from_raw(process.id() as i32), Signal::SIGKILL);
    let _ = process.kill();
    let _ = process.wait();
}
