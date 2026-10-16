use super::super::RunResult;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub(super) fn validate_hooks(declarations: &BTreeMap<String, String>) -> RunResult<()> {
    let bytes: usize = declarations
        .iter()
        .map(|(name, content)| name.len() + content.len())
        .sum();
    if declarations
        .values()
        .any(|content| content.is_empty() || content.contains('\0'))
        || bytes > 1024 * 1024
        || declarations.len() > 32
        || declarations.keys().any(|name| {
            name.len() > 64
                || !name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
    {
        return Err("invalid fixture hooks".into());
    }
    Ok(())
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
