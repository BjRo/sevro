use super::{
    RunError, RunResult,
    options::{PATH_SETTINGS, Values, selected},
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub(super) fn merge(explicit: Values) -> RunResult<Values> {
    let Some(file) = selected(&explicit, "run-manifest-file") else {
        return Ok(explicit);
    };
    let path = std::env::current_dir()?.join(file);
    let (mut values, canonical) = read(&path).map_err(|detail| {
        RunError::with_source(format!(
            "--run-manifest-file {}: {detail}; correct the named field or select a readable manifest",
            path.display()
        ), detail)
    })?;
    if explicit.contains_key("case-file") {
        for name in [
            "extension-command-file",
            "extension-source-file",
            "case-id",
            "extension-configuration-file",
            "extension-redacted-configuration-file",
        ] {
            values.remove(name);
        }
    }
    if explicit.contains_key("extension-command-file") {
        values.remove("case-file");
    }
    if explicit.contains_key("adapter-module") {
        for name in [
            "host",
            "model",
            "effort",
            "codex-bin",
            "codex-auth-file",
            "codex-timeout-ms",
        ] {
            values.remove(name);
        }
    }
    if explicit.contains_key("host") {
        values.remove("adapter-module");
    }
    values.extend(explicit);
    values.insert(
        "run-manifest-file".into(),
        vec![canonical.to_string_lossy().into_owned()],
    );
    Ok(values)
}

fn read(path: &Path) -> RunResult<(Values, PathBuf)> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(
            "run manifest $: use a regular, non-symlink JSON file of at most 64 KiB".into(),
        );
    }
    let source = fs::read(path)?;
    let value: Value = serde_json::from_slice(&source).map_err(|error| {
        RunError::with_source("run manifest $: invalid JSON; check the JSON syntax", error)
    })?;
    let root = value
        .as_object()
        .ok_or("run manifest $: expected an object")?;
    for key in root.keys() {
        if !["format", "settings"].contains(&key.as_str()) {
            return Err(
                format!("run manifest {key}: unknown field; use format and settings").into(),
            );
        }
    }
    if root.get("format").and_then(Value::as_str) != Some("sevro.run.v1") {
        return Err("run manifest format: expected \"sevro.run.v1\"".into());
    }
    let settings = root
        .get("settings")
        .and_then(Value::as_object)
        .ok_or("run manifest settings: expected an object of run options")?;
    let canonical = fs::canonicalize(path)?;
    let base = canonical.parent().ok_or("invalid manifest path")?;
    let mut resolved = Values::new();
    for (name, value) in settings {
        let field = format!("run manifest settings.{name}");
        if name == "extension-source-file" {
            let sources = value
                .as_array()
                .ok_or_else(|| format!("{field}: expected an array of nonempty strings"))?;
            let sources = sources
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .filter(|value| !value.trim().is_empty())
                        .map(|value| base.join(value).to_string_lossy().into_owned())
                        .ok_or_else(|| {
                            format!("{field}: expected an array of nonempty strings").into()
                        })
                })
                .collect::<RunResult<Vec<_>>>()?;
            resolved.insert(name.clone(), sources);
            continue;
        }
        let value = match name.as_str() {
            "dry" => value
                .as_bool()
                .map(|value| value.to_string())
                .ok_or_else(|| format!("{field}: expected a boolean"))?,
            "trials" | "jobs" | "threshold" | "codex-timeout-ms" => value
                .as_number()
                .map(ToString::to_string)
                .ok_or_else(|| format!("{field}: expected a finite number"))?,
            "case-file"
            | "case-id"
            | "adapter-module"
            | "extension-command-file"
            | "extension-configuration-file"
            | "extension-redacted-configuration-file"
            | "case-source-root"
            | "case-source-map-file"
            | "host"
            | "codex-bin"
            | "codex-auth-file"
            | "model"
            | "effort"
            | "project-root"
            | "config-root"
            | "results-root"
            | "run-state-root"
            | "runtime-config-file"
            | "runner-build-digest"
            | "project-digest"
            | "condition" => value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("{field}: expected a nonempty string"))?,
            _ => {
                return Err(format!("{field}: unknown saved option; see sevro run --help").into());
            }
        };
        let value = if PATH_SETTINGS.contains(&name.as_str()) {
            base.join(value).to_string_lossy().into_owned()
        } else {
            value
        };
        resolved.insert(name.clone(), vec![value]);
    }
    Ok((resolved, canonical))
}
