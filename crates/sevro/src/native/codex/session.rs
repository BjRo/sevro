use serde_json::Value;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_SESSION_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SESSION_FILES: usize = 1024;
const MAX_SESSION_ENTRIES: usize = 10_000;
const MAX_TOOL_CALLS: usize = 128;

pub(super) fn last_ordinal(home: &Path, thread: &str) -> Option<u64> {
    let path = locate(home, thread)?;
    let file = File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_SESSION_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_SESSION_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_SESSION_BYTES {
        return None;
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    let mut last = None;
    let mut tools = 0;
    for (index, line) in text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
    {
        if index >= MAX_SESSION_ENTRIES {
            return None;
        }
        let entry: Value = serde_json::from_str(line).ok()?;
        let ordinal = entry["ordinal"].as_f64()?;
        if !(0.0..=9_007_199_254_740_991.0).contains(&ordinal)
            || ordinal.fract() != 0.0
            || last.is_some_and(|previous| ordinal <= previous as f64)
        {
            return None;
        }
        let payload = entry["payload"].as_object()?;
        if matches!(
            payload.get("type").and_then(Value::as_str),
            Some("function_call" | "custom_tool_call")
        ) {
            tools += 1;
            // Direct native control calls are a subset of these tool calls.
            if tools > MAX_TOOL_CALLS {
                return None;
            }
        }
        last = Some(ordinal as u64);
    }
    last
}

fn locate(home: &Path, thread: &str) -> Option<PathBuf> {
    if thread.is_empty()
        || thread.len() > 128
        || !thread
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return None;
    }
    let root = home.join("sessions");
    if !fs::symlink_metadata(&root).ok()?.is_dir() {
        return None;
    }
    let suffix = format!("-{thread}.jsonl");
    let mut pending = vec![root];
    let mut found = None;
    let mut visited = 0;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).ok()? {
            let entry = entry.ok()?;
            visited += 1;
            let kind = entry.file_type().ok()?;
            if visited > MAX_SESSION_FILES || kind.is_symlink() {
                return None;
            }
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(&suffix) {
                if found.is_some() {
                    return None;
                }
                found = Some(entry.path());
            }
        }
    }
    found
}
