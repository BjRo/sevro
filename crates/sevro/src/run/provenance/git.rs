use super::{RunError, RunResult, hash_json};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_DIRTY_BYTES: usize = 32 * 1024 * 1024;

pub(super) struct GitIdentity {
    pub revision: Option<String>,
    pub dirty_patch_digest: Option<String>,
}

impl GitIdentity {
    fn unknown() -> Self {
        Self {
            revision: None,
            dirty_patch_digest: None,
        }
    }
}

pub(super) fn project(root: &Path, excluded: &[PathBuf]) -> RunResult<GitIdentity> {
    let Some(entry) = enclosing_git_entry(root)? else {
        return Ok(GitIdentity::unknown());
    };
    let git_root = git(root, &["rev-parse", "--show-toplevel"])?;
    let git_root = fs::canonicalize(String::from_utf8_lossy(&git_root).trim())?;
    if git_root != entry {
        return Err("project Git root does not match its repository entry".into());
    }
    let revision = match git(&git_root, &["rev-parse", "HEAD"]) {
        Ok(revision) => String::from_utf8_lossy(&revision).trim().to_owned(),
        Err(_) => {
            git(&git_root, &["status", "--porcelain"])?;
            return Ok(GitIdentity::unknown());
        }
    };
    if !(40..=64).contains(&revision.len())
        || !revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("project Git revision is invalid".into());
    }
    Ok(GitIdentity {
        revision: Some(revision),
        dirty_patch_digest: dirty_digest(&git_root, excluded)?,
    })
}

fn enclosing_git_entry(root: &Path) -> RunResult<Option<PathBuf>> {
    for path in root.ancestors() {
        let entry = path.join(".git");
        match fs::symlink_metadata(&entry) {
            Ok(_metadata) => {
                #[cfg(target_os = "linux")]
                if empty_temporary_placeholder(path, &entry, &_metadata)? {
                    continue;
                }
                return Ok(Some(path.to_owned()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(RunError::with_source(
                    format!("cannot inspect project provenance: {error}"),
                    error,
                ));
            }
        }
    }
    Ok(None)
}

#[cfg(target_os = "linux")]
fn empty_temporary_placeholder(
    directory: &Path,
    metadata_path: &Path,
    metadata: &fs::Metadata,
) -> RunResult<bool> {
    if (directory == Path::new("/tmp") || directory == std::env::temp_dir()) && metadata.is_dir() {
        return fs::read_dir(metadata_path)
            .map(|mut entries| entries.next().is_none())
            .map_err(RunError::from);
    }
    Ok(false)
}

fn git(root: &Path, arguments: &[&str]) -> RunResult<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
        )
        .env("LC_ALL", "C")
        .stderr(Stdio::null())
        .output()
        .map_err(|error| RunError::with_source("Git identity is unavailable", error))?;
    if !output.status.success() {
        return Err("Git identity is unavailable".into());
    }
    if output.stdout.len() > MAX_DIRTY_BYTES {
        return Err("Git identity exceeds the size limit".into());
    }
    Ok(output.stdout)
}

fn dirty_digest(root: &Path, excluded: &[PathBuf]) -> RunResult<Option<String>> {
    let tracked_patch = git(root, &["diff", "--binary", "HEAD", "--"])?;
    let untracked_paths = git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let untracked_paths = String::from_utf8_lossy(&untracked_paths);
    let mut paths = untracked_paths
        .split('\0')
        .filter(|path| !path.is_empty())
        .filter(|path| {
            !excluded
                .iter()
                .any(|excluded| root.join(path).starts_with(excluded))
        })
        .collect::<Vec<_>>();
    paths.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let mut bytes = tracked_patch.len();
    let mut untracked = Vec::new();
    for path in paths {
        let content = untracked_bytes(root, path)?;
        bytes += content.len();
        if bytes > MAX_DIRTY_BYTES {
            return Err("Git identity exceeds the size limit".into());
        }
        untracked.push(json!({"path":path,"sha256":format!("{:x}",Sha256::digest(content))}));
    }
    if tracked_patch.is_empty() && untracked.is_empty() {
        return Ok(None);
    }
    hash_json(&json!({"trackedPatch":format!("{:x}",Sha256::digest(tracked_patch)),"untracked":untracked}))
        .map(Some)
}

fn untracked_bytes(root: &Path, path: &str) -> RunResult<Vec<u8>> {
    if Path::new(path).components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Git checkout has an unsafe untracked path".into());
    }
    let path = root.join(path);
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.is_symlink() {
        return fs::read_link(&path)
            .map(|target| target.to_string_lossy().as_bytes().to_owned())
            .map_err(RunError::from);
    }
    if metadata.is_file() {
        return fs::read(&path).map_err(RunError::from);
    }
    Err("Git checkout has an unsupported untracked entry".into())
}
