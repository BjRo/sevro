use super::{RunError, RunResult, options::Options};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;

pub(super) struct RuntimeSelection {
    pub path: Option<PathBuf>,
    pub policy: Option<Value>,
}

pub(super) fn load(options: &Options) -> RunResult<RuntimeSelection> {
    let path = options
        .runtime_config_file
        .clone()
        .unwrap_or_else(|| options.project_root.join("sevro.json"));
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error)
            if options.runtime_config_file.is_none()
                && error.kind() == std::io::ErrorKind::NotFound =>
        {
            return Ok(RuntimeSelection {
                path: None,
                policy: None,
            });
        }
        Err(error) => {
            return Err(RunError::with_source(
                format!(
                    "invalid runtime configuration: cannot inspect {}: {error}",
                    path.display()
                ),
                error,
            ));
        }
    };
    if !metadata.is_file() || metadata.len() > 65536 {
        return Err("invalid runtime configuration: expected a regular file up to 64 KiB".into());
    }
    let bytes = fs::read(&path).map_err(|error| {
        RunError::with_source(
            format!(
                "invalid runtime configuration: cannot read {}: {error}",
                path.display()
            ),
            error,
        )
    })?;
    let source = String::from_utf8_lossy(&bytes);
    if source.len() > 65536 {
        return Err("invalid runtime configuration: runtime configuration exceeds 64 KiB".into());
    }
    let value: Value = serde_json::from_str(&source)
        .map_err(|error| RunError::with_source("invalid runtime configuration", error))?;
    if value != json!({"format":"sevro.runtime.v1"}) {
        return Err("invalid runtime configuration: this Rust slice supports only the sevro.runtime.v1 format declaration".into());
    }
    let canonical = fs::canonicalize(&path).map_err(|error| {
        RunError::with_source(
            format!(
                "invalid runtime configuration: cannot resolve {}: {error}",
                path.display()
            ),
            error,
        )
    })?;
    Ok(RuntimeSelection {
        path: Some(canonical),
        policy: Some(json!({
            "format":"sevro.runtime.v1", "environment":{}, "readOnlyRoots":[],
            "discovery":[], "skippedOptionalReadOnlyRoots":[], "seeds":[],
            "hooks":{"nativeGoal":false,"plugins":[]}
        })),
    })
}
