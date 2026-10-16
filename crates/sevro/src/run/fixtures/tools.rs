use super::super::{RunResult, storage};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub(super) fn validate_hooks(declarations: &BTreeMap<String, String>) -> RunResult<()> {
    validate(declarations, 32, "invalid fixture hooks", |name| {
        name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            && name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

pub(super) fn validate_bin(declarations: &BTreeMap<String, String>) -> RunResult<()> {
    validate(declarations, 64, "invalid fixture binaries", |name| {
        name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    })
}

fn validate(
    declarations: &BTreeMap<String, String>,
    maximum: usize,
    message: &str,
    valid_name: impl Fn(&str) -> bool,
) -> RunResult<()> {
    let bytes: usize = declarations
        .iter()
        .map(|(name, content)| name.len() + content.len())
        .sum();
    if declarations
        .values()
        .any(|content| content.is_empty() || content.contains('\0'))
        || bytes > 1024 * 1024
        || declarations.len() > maximum
        || declarations
            .keys()
            .any(|name| name.len() > 64 || !valid_name(name))
    {
        return Err(message.into());
    }
    Ok(())
}

pub(super) fn install_bin(
    declarations: Option<&BTreeMap<String, String>>,
    workspace: &Path,
) -> RunResult<()> {
    let Some(declarations) = declarations.filter(|entries| !entries.is_empty()) else {
        return Ok(());
    };
    let directory = workspace.join(".git/fixture-bin");
    storage::private_directory(&directory)?;
    install(
        declarations,
        &directory,
        "fixture binary directory is invalid",
        "fixture binary target is invalid",
    )
}

pub(super) fn bin_directory(workspace: &Path) -> RunResult<Option<PathBuf>> {
    let directory = workspace.join(".git/fixture-bin");
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() {
        return Err("fixture binary directory is invalid".into());
    }
    if fs::canonicalize(&directory)? != fs::canonicalize(workspace)?.join(".git/fixture-bin") {
        return Err("fixture binary directory escapes the workspace".into());
    }
    Ok(Some(directory))
}

pub(super) fn install(
    declarations: &BTreeMap<String, String>,
    directory: &Path,
    directory_error: &str,
    target_error: &str,
) -> RunResult<()> {
    if !fs::symlink_metadata(directory)?.is_dir() {
        return Err(directory_error.into());
    }
    for (name, content) in declarations {
        let target = directory.join(name);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if !metadata.is_file() => return Err(target_error.into()),
            Err(error) if error.kind() != ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o755)
            .open(&target)?
            .write_all(content.as_bytes())?;
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}
