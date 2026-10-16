use nix::unistd::{User, getuid};
use std::collections::BTreeSet;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub(super) fn namespace_directory(path: &Path) -> Result<(), String> {
    match private_directory(path) {
        Ok(()) => {}
        Err(_) if path.exists() => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "native namespace is unavailable")?;
    if !metadata.is_dir() || metadata.uid() != getuid().as_raw() || metadata.mode() & 0o077 != 0 {
        return Err("native state namespace must be an owned private directory".into());
    }
    Ok(())
}

pub(super) fn private_directory(path: &Path) -> Result<(), String> {
    DirBuilder::new()
        .mode(0o700)
        .create(path)
        .map_err(|_| "native private directory could not be created".into())
}

pub(super) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|_| "native private file could not be written".into())
}

pub(super) fn protected_roots(
    project_root: &Path,
    results_root: &Path,
    additional_roots: &[PathBuf],
    workspace: &Path,
    native_namespace: &Path,
) -> Result<Vec<PathBuf>, String> {
    let mut candidates = vec![
        project_root.to_path_buf(),
        results_root.to_path_buf(),
        native_namespace.to_path_buf(),
        workspace
            .parent()
            .ok_or("Codex workspace has no private parent")?
            .to_path_buf(),
    ];
    candidates.extend(additional_roots.iter().cloned());
    let user = User::from_uid(getuid())
        .map_err(|_| "native user information is unavailable")?
        .ok_or("native user information is unavailable")?;
    candidates.push(user.dir);
    candidates.extend(std::env::var_os("HOME").map(PathBuf::from));
    for name in ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] {
        if let Some(path) = std::env::var_os(name) {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err("evaluation protected roots must be absolute".into());
            }
            if path.exists() {
                candidates.push(path);
            }
        }
    }
    let executable = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|_| "running Sevro executable is unavailable")?;
    let mut roots = BTreeSet::from([executable]);
    for candidate in candidates {
        let canonical =
            fs::canonicalize(candidate).map_err(|_| "evaluation protected root is unreadable")?;
        if canonical == workspace {
            continue;
        }
        if canonical != native_namespace && Some(canonical.as_path()) != workspace.parent() {
            roots.extend(protected_worktrees(&canonical)?);
        }
        roots.insert(canonical);
    }
    roots.remove(workspace);
    Ok(roots.into_iter().collect())
}

fn protected_worktrees(path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut current = if path.is_dir() {
        path
    } else {
        path.parent().ok_or("protected path has no parent")?
    };
    loop {
        if has_repository_metadata(current)? {
            break;
        }
        let Some(parent) = current.parent() else {
            return Ok(vec![]);
        };
        current = parent;
    }
    let output = Command::new("git")
        .args(["-C"])
        .arg(current)
        .args(["worktree", "list", "--porcelain", "-z"])
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
        )
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "protected repository worktrees are unavailable")?;
    if !output.status.success() || output.stdout.len() > 1024 * 1024 {
        return Err("protected repository worktrees are unavailable".into());
    }
    let text =
        String::from_utf8(output.stdout).map_err(|_| "protected repository paths are invalid")?;
    let mut roots = Vec::new();
    for path in text
        .split('\0')
        .filter_map(|entry| entry.strip_prefix("worktree "))
    {
        if !Path::new(path).is_absolute() {
            return Err("protected repository paths are invalid".into());
        }
        match fs::canonicalize(path) {
            Ok(path) => roots.push(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("protected repository worktree is unreadable".into()),
        }
    }
    if roots.is_empty() {
        return Err("protected repository worktrees are unavailable".into());
    }
    Ok(roots)
}

fn has_repository_metadata(directory: &Path) -> Result<bool, String> {
    let entry = directory.join(".git");
    let Ok(_metadata) = entry.symlink_metadata() else {
        return Ok(false);
    };
    #[cfg(target_os = "linux")]
    if (directory == Path::new("/tmp") || directory == std::env::temp_dir()) && _metadata.is_dir() {
        // Codex's Linux sandbox can leave an empty mount placeholder here.
        return fs::read_dir(entry)
            .and_then(|mut entries| entries.next().transpose())
            .map(|entry| entry.is_some())
            .map_err(|_| "protected repository metadata is unreadable".into());
    }
    Ok(true)
}
