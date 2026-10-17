use super::super::super::{RunError, RunResult, preparation::fixture_path, storage};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub(in crate::run::fixtures) fn validate(
    files: Option<&BTreeMap<String, String>>,
    staged: &[String],
) -> RunResult<()> {
    if files.map_or(0, BTreeMap::len) > 1024 {
        return Err("repository fixture exceeds the file limit".into());
    }
    let mut paths: Vec<String> = Vec::new();
    let mut bytes = 0usize;
    for (path, content) in files.into_iter().flatten() {
        fixture_path(path)?;
        if path
            .split('/')
            .any(|part| part.eq_ignore_ascii_case(".git"))
        {
            return Err("repository fixture cannot write repository metadata".into());
        }
        bytes = bytes
            .saturating_add(path.len())
            .saturating_add(content.len());
        if bytes > 32 * 1024 * 1024 {
            return Err("repository fixture exceeds the size limit".into());
        }
        let normalized = path.to_lowercase();
        if paths.iter().any(|other| {
            normalized == *other
                || normalized.starts_with(&format!("{other}/"))
                || other.starts_with(&format!("{normalized}/"))
        }) {
            return Err("repository fixture overlay paths collide".into());
        }
        paths.push(normalized);
    }
    for path in staged {
        bytes = bytes.saturating_add(path.len());
    }
    if bytes > 32 * 1024 * 1024 {
        return Err("repository fixture exceeds the size limit".into());
    }
    let mut staged_paths = BTreeSet::new();
    if staged.iter().any(|path| {
        !staged_paths.insert(path.to_lowercase())
            || files.is_none_or(|files| !files.contains_key(path))
    }) {
        return Err("invalid repository fixture staging".into());
    }
    Ok(())
}

pub(in crate::run::fixtures) fn apply(
    files: &BTreeMap<String, String>,
    staged: &[String],
    workspace: &Path,
) -> RunResult<()> {
    for (path, content) in files {
        let target = target(workspace, path)?;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(target)
            .and_then(|mut file| file.write_all(content.as_bytes()))
            .map_err(|error| {
                RunError::with_source(
                    format!("cannot write repository fixture overlay: {error}"),
                    error,
                )
            })?;
    }
    if !staged.is_empty() {
        let mut arguments = vec!["-c", "core.hooksPath=/dev/null", "add", "--"];
        arguments.extend(staged.iter().map(String::as_str));
        super::git(workspace, &arguments)?;
    }
    Ok(())
}

fn target(workspace: &Path, path: &str) -> RunResult<PathBuf> {
    let mut components = path.split('/').peekable();
    let mut target = workspace.to_path_buf();
    while let Some(component) = components.next() {
        target.push(component);
        let parent = components.peek().is_some();
        match fs::symlink_metadata(&target) {
            Ok(entry) if parent && !entry.is_dir() => {
                return Err("repository fixture overlay traverses a non-directory".into());
            }
            Ok(entry) if !parent && !entry.is_file() => {
                return Err("repository fixture overlay targets a non-file".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if parent {
                    storage::new_directory(&target)?;
                }
            }
            Err(error) => {
                return Err(RunError::with_source(
                    format!("cannot inspect repository fixture overlay: {error}"),
                    error,
                ));
            }
        }
    }
    Ok(target)
}
