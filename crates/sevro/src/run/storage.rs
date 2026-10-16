use super::{RunError, RunResult};
use serde::Serialize;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use uuid::Uuid;

pub(super) fn private_directory(path: &Path) -> RunResult<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|error| {
            RunError::with_source(
                format!("cannot create directory {}: {error}", path.display()),
                error,
            )
        })
}

pub(super) fn new_directory(path: &Path) -> RunResult<()> {
    DirBuilder::new().mode(0o700).create(path).map_err(|error| {
        RunError::with_source(
            format!(
                "cannot create private directory {}: {error}",
                path.display()
            ),
            error,
        )
    })
}

pub(super) fn atomic_json(path: &Path, value: &impl Serialize) -> RunResult<()> {
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let write = || -> RunResult<()> {
        let mut bytes = serde_json::to_vec_pretty(value)?;
        bytes.push(b'\n');
        write_private(&temporary, &bytes)?;
        fs::rename(&temporary, path).map_err(|error| {
            RunError::with_source(format!("cannot retain {}: {error}", path.display()), error)
        })
    };
    let result = write();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(super) fn write_private(path: &Path, bytes: &[u8]) -> RunResult<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|error| {
            RunError::with_source(
                format!("cannot write private file {}: {error}", path.display()),
                error,
            )
        })
}

pub(super) fn cleanup(workspace: &Path) -> RunResult<()> {
    let removed = fs::remove_dir_all(workspace).or_else(|error| {
        if error.kind() != std::io::ErrorKind::PermissionDenied {
            return Err(error);
        }
        restore_directory_access(workspace)?;
        fs::remove_dir_all(workspace)
    });
    removed.map_err(|error| {
        RunError::with_source(
            format!("cannot remove workspace {}: {error}", workspace.display()),
            error,
        )
    })
}

fn restore_directory_access(path: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Ok(());
    }
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(metadata.permissions().mode() | 0o700),
    )?;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            restore_directory_access(&entry.path())?;
        }
    }
    Ok(())
}
