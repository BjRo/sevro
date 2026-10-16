use super::super::{RunError, RunResult, preparation::fixture_path, storage};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::run) struct GeneratedFixture {
    kind: String,
    commits: Vec<Commit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    staged: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit_files: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hooks: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bin: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Commit {
    message: String,
    files: BTreeMap<String, String>,
}

impl GeneratedFixture {
    pub(in crate::run) fn validate(&self) -> RunResult<()> {
        if self.commits.len() > 128 {
            return Err("invalid generated fixture".into());
        }
        if let Some(hooks) = &self.hooks {
            super::tools::validate_hooks(hooks)?;
        }
        if let Some(bin) = &self.bin {
            super::tools::validate_bin(bin)?;
        }
        let mut files = 0;
        let mut bytes = 0;
        for commit in &self.commits {
            if commit.message.trim().is_empty()
                || commit.message.len() > 4096
                || commit.files.is_empty()
            {
                return Err("invalid generated fixture commit".into());
            }
            bytes += commit.message.len();
        }
        for entries in self
            .commits
            .iter()
            .map(|commit| &commit.files)
            .chain(self.files.iter())
        {
            for (path, content) in entries {
                fixture_path(path)?;
                if path
                    .split('/')
                    .any(|part| part.eq_ignore_ascii_case(".git"))
                {
                    return Err("generated fixture cannot write repository metadata".into());
                }
                files += 1;
                bytes += path.len() + content.len();
            }
        }
        bytes += self.staged.iter().flatten().map(String::len).sum::<usize>();
        if files > 1024 || bytes > 32 * 1024 * 1024 {
            return Err("generated fixture exceeds the size limit".into());
        }
        let paths = self
            .paths()
            .into_iter()
            .map(|path| path.to_lowercase())
            .collect::<Vec<_>>();
        for (index, path) in paths.iter().enumerate() {
            if paths[..index].iter().any(|other| {
                path == other
                    || path.starts_with(&format!("{other}/"))
                    || other.starts_with(&format!("{path}/"))
            }) {
                return Err("generated fixture paths collide".into());
            }
        }
        let mut staged_paths = BTreeSet::new();
        if self.staged.iter().flatten().any(|path| {
            !staged_paths.insert(path.to_lowercase())
                || !self
                    .files
                    .as_ref()
                    .is_some_and(|files| files.contains_key(path))
        }) || (self.commit_files == Some(true)
            && self.files.as_ref().is_none_or(BTreeMap::is_empty))
        {
            return Err("invalid generated fixture staging".into());
        }
        Ok(())
    }

    pub(super) fn paths(&self) -> Vec<String> {
        self.commits
            .iter()
            .flat_map(|commit| commit.files.keys())
            .chain(self.files.iter().flat_map(|files| files.keys()))
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub(super) fn materialize(&self, workspace: &Path) -> RunResult<()> {
        git(workspace, &["init", "--quiet", "--initial-branch=main"])?;
        for commit in &self.commits {
            write_files(workspace, &commit.files)?;
            add(workspace, commit.files.keys().map(String::as_str))?;
            git(workspace, &["commit", "--quiet", "-m", &commit.message])?;
        }
        if let Some(files) = &self.files {
            write_files(workspace, files)?;
            if self.commit_files == Some(true) {
                add(workspace, files.keys().map(String::as_str))?;
                git(
                    workspace,
                    &["commit", "--quiet", "-m", "Add evaluation scaffolding"],
                )?;
            }
        }
        if let Some(staged) = &self.staged
            && !staged.is_empty()
        {
            add(workspace, staged.iter().map(String::as_str))?;
        }
        super::tools::install_bin(self.bin.as_ref(), workspace)?;
        if let Some(hooks) = &self.hooks {
            super::tools::install(
                hooks,
                &workspace.join(".git/hooks"),
                "fixture Git hooks directory is invalid",
                "fixture Git hook target is invalid",
            )?;
        }
        Ok(())
    }
}

fn write_files(workspace: &Path, files: &BTreeMap<String, String>) -> RunResult<()> {
    for (path, content) in files {
        let target = workspace.join(path);
        storage::private_directory(target.parent().ok_or("fixture file has no parent")?)?;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&target)
            .and_then(|mut file| file.write_all(content.as_bytes()))
            .map_err(|error| {
                RunError::with_source(
                    format!(
                        "cannot write generated fixture file {}: {error}",
                        target.display()
                    ),
                    error,
                )
            })?;
    }
    Ok(())
}

fn add<'a>(workspace: &Path, paths: impl Iterator<Item = &'a str>) -> RunResult<()> {
    git(
        workspace,
        &std::iter::once("add")
            .chain(std::iter::once("--"))
            .chain(paths)
            .collect::<Vec<_>>(),
    )
}

fn bounded_output(stream: impl Read) -> RunResult<()> {
    let mut bytes = Vec::new();
    stream
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| RunError::with_source("generated fixture Git operation failed", error))?;
    if bytes.len() > 64 * 1024 {
        return Err("generated fixture Git output is too large".into());
    }
    Ok(())
}

fn git(workspace: &Path, arguments: &[&str]) -> RunResult<()> {
    let mut process = Command::new("git")
        .args(["-c", "core.hooksPath=/dev/null"])
        .args(arguments)
        .current_dir(workspace)
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
        )
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "Sevro Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@sevro.invalid")
        .env("GIT_COMMITTER_NAME", "Sevro Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@sevro.invalid")
        .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00+00:00")
        .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00+00:00")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| RunError::with_source("generated fixture Git operation failed", error))?;
    let stdout = process
        .stdout
        .take()
        .ok_or("generated Git stdout unavailable")?;
    let stderr = process
        .stderr
        .take()
        .ok_or("generated Git stderr unavailable")?;
    let reads = std::thread::scope(|scope| {
        let (sender, receiver) = std::sync::mpsc::channel();
        let stderr_sender = sender.clone();
        scope.spawn(move || {
            let _ = sender.send(bounded_output(stdout));
        });
        scope.spawn(move || {
            let _ = stderr_sender.send(bounded_output(stderr));
        });
        let mut result = Ok(());
        for read in receiver {
            if read.is_err() {
                let _ = process.kill();
                result = read;
            }
        }
        result
    });
    let status = process
        .wait()
        .map_err(|error| RunError::with_source("generated fixture Git operation failed", error))?;
    reads?;
    if !status.success() {
        return Err("generated fixture Git operation failed".into());
    }
    Ok(())
}
