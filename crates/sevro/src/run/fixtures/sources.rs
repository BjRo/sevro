use super::super::{RunError, RunResult, options::Options};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

pub(super) struct Sources {
    pub root: PathBuf,
    pub refs: BTreeMap<String, String>,
}

pub(super) fn read(options: &Options) -> RunResult<Option<Sources>> {
    options
        .case_source_root
        .as_ref()
        .zip(options.case_source_map_file.as_ref())
        .map(|(root, map_file)| {
            let bytes = fs::read(map_file).map_err(|error| {
                RunError::with_source("case source map file is unreadable or invalid", error)
            })?;
            let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
                RunError::with_source("case source map file is unreadable or invalid", error)
            })?;
            let refs: BTreeMap<String, String> =
                serde_json::from_value(value).map_err(|error| {
                    RunError::with_source("case source map must contain file URLs", error)
                })?;
            if refs
                .values()
                .any(|location| !location.starts_with("file:///"))
            {
                return Err("case source map must contain file URLs".into());
            }
            Ok(Sources {
                root: root.clone(),
                refs,
            })
        })
        .transpose()
}
