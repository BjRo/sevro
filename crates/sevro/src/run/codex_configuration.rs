use super::{
    RunError, RunResult,
    options::{Candidate, Options},
};
use std::fs;
use std::io;
use std::num::NonZeroU64;
use std::path::Path;

pub(super) fn load(options: &Options) -> RunResult<Option<NonZeroU64>> {
    if !matches!(options.candidate, Candidate::Codex { .. }) {
        return Ok(None);
    }
    let path = options.config_root.join(".codex/config.toml");
    let Some(bytes) = read_configuration(&options.config_root, &path).map_err(|error| {
        RunError::with_source(
            format!("Cannot read Codex configuration: {}", path.display()),
            error,
        )
    })?
    else {
        return Ok(None);
    };
    let source = String::from_utf8_lossy(&bytes);
    let configuration = toml::de::DeTable::parse(&source).map_err(|error| {
        RunError::with_source(
            format!("Invalid Codex configuration: {}", path.display()),
            error,
        )
    })?;
    let Some(agents) = configuration.get_ref().get("agents") else {
        return Ok(None);
    };
    let agents = agents
        .get_ref()
        .as_table()
        .ok_or_else(|| format!("Expected an agents table in {}", path.display()))?;
    let Some(limit) = agents.get("max_concurrent_threads_per_session") else {
        return Ok(None);
    };
    limit
        .get_ref()
        .as_integer()
        .and_then(|integer| u64::from_str_radix(integer.as_str(), integer.radix()).ok())
        .filter(|value| (1..=9_007_199_254_740_991).contains(value))
        .and_then(NonZeroU64::new)
        .map(Some)
        .ok_or_else(|| {
            format!(
                "Expected a positive integer for agents.max_concurrent_threads_per_session in {}",
                path.display()
            )
            .into()
        })
}

fn read_configuration(root: &Path, path: &Path) -> io::Result<Option<Vec<u8>>> {
    let directory = root.join(".codex");
    match fs::symlink_metadata(&directory) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    if !fs::metadata(directory)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "configuration directory is unreadable",
        ));
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let canonical = fs::canonicalize(path)?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 || !canonical.starts_with(root) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "configuration must be a contained regular file up to 64 KiB",
        ));
    }
    fs::read(path).map(Some)
}
