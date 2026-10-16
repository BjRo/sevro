use super::super::{RunError, RunResult, preparation::Check};
use super::{CheckResult, CheckStatus, PreparedOutput};
use crate::cancellation::Cancellation;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant};

const OBSERVATION: &str = "sevro.observation.git-head";
const MAX_OUTPUT: u64 = 128;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
pub(in crate::run) enum Kind {
    Changed,
    Unchanged,
    BaseAncestor,
}

pub(in crate::run) fn prepare(configuration: &BTreeMap<String, Value>) -> RunResult<Kind> {
    if configuration.len() != 1 {
        return Err("invalid Git HEAD check declaration".into());
    }
    match configuration.get("kind").and_then(Value::as_str) {
        Some("changed") => Ok(Kind::Changed),
        Some("unchanged") => Ok(Kind::Unchanged),
        Some("base-ancestor") => Ok(Kind::BaseAncestor),
        _ => Err("invalid Git HEAD check declaration".into()),
    }
}

pub(in crate::run) struct Base(String);

pub(in crate::run) fn capture_base(
    checks: &[Check],
    workspace: &Path,
    cancellation: &Cancellation,
) -> RunResult<Option<Base>> {
    if !checks
        .iter()
        .any(|check| matches!(check.prepared, PreparedOutput::GitHead(_)))
    {
        return Ok(None);
    }
    revision(workspace, cancellation).map(Base).map(Some)
}

pub(in crate::run) struct Context<'a> {
    pub workspace: &'a Path,
    pub base: Option<&'a Base>,
    pub cancellation: &'a Cancellation,
}

impl Context<'_> {
    pub fn observe(&self, checks: &[Check]) -> RunResult<Option<State>> {
        if !checks
            .iter()
            .any(|check| matches!(check.prepared, PreparedOutput::GitHead(_)))
        {
            return Ok(None);
        }
        self.state()
            .map(Some)
            .map_err(|error| RunError::with_source("Git HEAD grading did not complete", error))
    }

    fn state(&self) -> RunResult<State> {
        let base = self.base.ok_or("Git HEAD base revision is unavailable")?;
        let current_revision = revision(self.workspace, self.cancellation)?;
        let (status, _) = git(
            self.workspace,
            &["merge-base", "--is-ancestor", &base.0, &current_revision],
            self.cancellation,
        )?;
        let base_ancestor = match status.code() {
            Some(0) => true,
            Some(1) => false,
            _ => return Err("Git HEAD ancestry is unavailable".into()),
        };
        Ok(State {
            base_revision: base.0.clone(),
            current_revision,
            base_ancestor,
        })
    }
}

pub(in crate::run) struct State {
    base_revision: String,
    current_revision: String,
    base_ancestor: bool,
}

impl State {
    pub fn check(&self, check: &Check, kind: Kind) -> CheckResult {
        let (passed, detail) = match kind {
            Kind::Changed => (
                self.current_revision != self.base_revision,
                "candidate did not create the expected commit",
            ),
            Kind::Unchanged => (
                self.current_revision == self.base_revision,
                "candidate created or switched to a different commit",
            ),
            Kind::BaseAncestor => (
                self.base_ancestor,
                "candidate replaced or diverged from the fixture history",
            ),
        };
        CheckResult {
            id: check.id.clone(),
            grader: check.grader.clone(),
            status: if passed {
                CheckStatus::Passed
            } else {
                CheckStatus::Failed
            },
            detail,
            evidence_refs: vec![OBSERVATION],
        }
    }

    pub fn satisfies(&self, id: &str) -> bool {
        id == OBSERVATION
    }

    pub fn observation(&self) -> Value {
        json!({
            "id":OBSERVATION,"source":"sevro.git-head","completeness":"complete",
            "data":{"baseRevision":self.base_revision,"currentRevision":self.current_revision,"baseAncestor":self.base_ancestor}
        })
    }
}

fn revision(workspace: &Path, cancellation: &Cancellation) -> RunResult<String> {
    let (status, output) = git(
        workspace,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        cancellation,
    )?;
    if !status.success()
        || !matches!(output.len(), 40 | 64)
        || !output
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Git HEAD revision is unavailable".into());
    }
    Ok(output)
}

struct OwnedProcess {
    child: Child,
    finished: bool,
}

impl OwnedProcess {
    fn stop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(id) = i32::try_from(self.child.id()) {
            let _ = killpg(Pid::from_raw(id), Signal::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.finished = true;
    }

    fn wait(
        &mut self,
        output: Receiver<RunResult<String>>,
        cancellation: &Cancellation,
    ) -> RunResult<(ExitStatus, String)> {
        let deadline = Instant::now() + TIMEOUT;
        let mut captured = None;
        loop {
            if captured.is_none() {
                match output.try_recv() {
                    Ok(value) => captured = Some(value?),
                    Err(TryRecvError::Empty) => {}
                    Err(TryRecvError::Disconnected) => {
                        return Err("Git HEAD output is unavailable".into());
                    }
                }
            }
            if cancellation.is_cancelled() {
                return Err("Git HEAD check cancelled".into());
            }
            if Instant::now() >= deadline {
                return Err("Git HEAD check timed out".into());
            }
            if let Some(captured) = captured.as_mut()
                && let Some(status) = self.child.try_wait()?
            {
                self.finished = true;
                return Ok((status, std::mem::take(captured)));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn git(
    workspace: &Path,
    arguments: &[&str],
    cancellation: &Cancellation,
) -> RunResult<(ExitStatus, String)> {
    if cancellation.is_cancelled() {
        return Err("Git HEAD check cancelled".into());
    }
    let metadata = fs::symlink_metadata(workspace.join(".git"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Git fixture metadata is not a directory".into());
    }
    let child = Command::new("git")
        .args(arguments)
        .current_dir(workspace)
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
        )
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()?;
    let mut process = OwnedProcess {
        child,
        finished: false,
    };
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or("Git HEAD stdout unavailable")?;
    std::thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel();
        scope.spawn(move || {
            let _ = sender.send(capture(stdout));
        });
        let result = process.wait(receiver, cancellation);
        if result.is_err() {
            process.stop();
        }
        result
    })
}

fn capture(stdout: impl Read) -> RunResult<String> {
    let mut bytes = Vec::new();
    stdout.take(MAX_OUTPUT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_OUTPUT {
        return Err("Git HEAD output is oversized".into());
    }
    let text = String::from_utf8(bytes)
        .map_err(|error| RunError::with_source("Git HEAD output is not UTF-8", error))?;
    Ok(text.trim().to_owned())
}
