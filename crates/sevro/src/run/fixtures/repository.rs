use super::super::{RunError, RunResult};
use super::sources::Sources;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_GIT_OUTPUT: u64 = 64 * 1024;

pub(in crate::run) struct RepositorySource {
    pub reference: String,
    pub revision: String,
    root: PathBuf,
    path: PathBuf,
}

impl RepositorySource {
    pub(super) fn protected_roots(&self) -> Vec<PathBuf> {
        vec![self.root.clone(), self.path.clone()]
    }
}

pub(super) fn resolve(sources: Option<&Sources>, reference: &str) -> RunResult<RepositorySource> {
    let sources = sources.ok_or("repository source root is required and must be absolute")?;
    let location = sources
        .refs
        .get(reference)
        .ok_or("repository source reference is not declared")?;
    let url = url::Url::parse(location)
        .map_err(|error| RunError::with_source("repository source is unreadable", error))?;
    let path = url
        .to_file_path()
        .map_err(|()| "repository source is unreadable")?;
    let root = fs::canonicalize(&sources.root)
        .map_err(|error| RunError::with_source("repository source is unreadable", error))?;
    let path = fs::canonicalize(path)
        .map_err(|error| RunError::with_source("repository source is unreadable", error))?;
    require_contained(&root, &path)?;
    let revision = revision(&path)?;
    Ok(RepositorySource {
        reference: reference.into(),
        revision,
        root,
        path,
    })
}

fn require_contained(root: &Path, path: &Path) -> RunResult<()> {
    if !path.starts_with(root) {
        return Err("repository source escapes its declared root".into());
    }
    if !path.is_dir() {
        return Err("repository source is unreadable".into());
    }
    Ok(())
}

fn revision(path: &Path) -> RunResult<String> {
    let top = git(path, &["rev-parse", "--show-toplevel"])?;
    let top = fs::canonicalize(top)
        .map_err(|error| RunError::with_source("repository source is unreadable", error))?;
    if top != path {
        return Err("repository source must name the repository root".into());
    }
    let revision = git(path, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    if !(40..=64).contains(&revision.len())
        || !revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("repository source has no valid commit".into());
    }
    let status = git(
        path,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?;
    if !status.is_empty() {
        return Err("repository source has uncommitted changes".into());
    }
    Ok(revision)
}

fn require_snapshot(source: &RepositorySource, message: &str) -> RunResult<()> {
    let path = fs::canonicalize(&source.path)
        .map_err(|error| RunError::with_source("repository source is unreadable", error))?;
    require_contained(&source.root, &path)?;
    if path != source.path || revision(&path)? != source.revision {
        return Err(message.into());
    }
    Ok(())
}

pub(super) fn clone(source: &RepositorySource, workspace: &Path) -> RunResult<()> {
    require_snapshot(source, "repository source changed during run")?;
    let path = source
        .path
        .to_str()
        .ok_or("repository source path is not UTF-8")?;
    let target = workspace.to_str().ok_or("fixture path is not UTF-8")?;
    git(
        workspace,
        &[
            "clone",
            "--no-hardlinks",
            "--no-checkout",
            "--no-recurse-submodules",
            "--quiet",
            path,
            target,
        ],
    )?;
    git(
        workspace,
        &["checkout", "--detach", "--quiet", &source.revision],
    )?;
    if git(workspace, &["rev-parse", "HEAD"])? != source.revision {
        return Err("repository fixture revision changed during clone".into());
    }
    for remote in git(workspace, &["remote"])?.lines() {
        git(workspace, &["remote", "remove", remote])?;
    }
    require_snapshot(source, "repository source changed during clone")
}

fn bounded_output(stream: impl Read) -> RunResult<Vec<u8>> {
    let mut bytes = Vec::new();
    stream
        .take(MAX_GIT_OUTPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            RunError::with_source(
                format!("repository fixture Git operation failed: {error}"),
                error,
            )
        })?;
    if bytes.len() as u64 > MAX_GIT_OUTPUT {
        return Err("repository fixture Git output is too large".into());
    }
    Ok(bytes)
}

fn git(path: &Path, arguments: &[&str]) -> RunResult<String> {
    let mut process = Command::new("git")
        .args(arguments)
        .current_dir(path)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            RunError::with_source(
                format!("repository fixture Git operation failed: {error}"),
                error,
            )
        })?;
    let stdout = process
        .stdout
        .take()
        .ok_or("repository Git stdout unavailable")?;
    let stderr = process
        .stderr
        .take()
        .ok_or("repository Git stderr unavailable")?;
    let (stdout, stderr) = std::thread::scope(|scope| {
        let stdout = scope.spawn(|| bounded_output(stdout));
        let stderr = scope.spawn(|| bounded_output(stderr));
        (
            stdout
                .join()
                .unwrap_or_else(|_| Err("repository Git stdout reader failed".into())),
            stderr
                .join()
                .unwrap_or_else(|_| Err("repository Git stderr reader failed".into())),
        )
    });
    if stdout.is_err() || stderr.is_err() {
        let _ = process.kill();
    }
    let status = process.wait().map_err(|error| {
        RunError::with_source(
            format!("repository fixture Git operation failed: {error}"),
            error,
        )
    })?;
    let stdout = String::from_utf8(stdout?).map_err(|error| {
        RunError::with_source("repository fixture Git output is not UTF-8", error)
    })?;
    String::from_utf8(stderr?).map_err(|error| {
        RunError::with_source("repository fixture Git output is not UTF-8", error)
    })?;
    if !status.success() {
        return Err("repository fixture Git operation failed".into());
    }
    Ok(stdout.trim().into())
}
mod overlay;

pub(super) use overlay::{apply as apply_overlay, validate as validate_overlay};
