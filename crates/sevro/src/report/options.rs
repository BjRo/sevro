use super::ReportResult;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

pub(super) fn result_paths(args: &[String]) -> ReportResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut latest = false;
    let mut root = None;
    let mut options = args.iter();
    while let Some(option) = options.next() {
        match option.as_str() {
            "--json" => {}
            "--latest" => latest = true,
            "--result-file" => files.push(value(&mut options, option)?),
            "--results-root" => root = Some(value(&mut options, option)?),
            "--" if options.len() == 0 => break,
            _ if option.starts_with("--result-file=") => files.push(option[14..].to_owned()),
            _ if option.starts_with("--results-root=") => root = Some(option[15..].to_owned()),
            _ => return Err(format!("unexpected report argument: {option}")),
        }
    }
    if latest && !files.is_empty() {
        return Err("--latest and --result-file are exclusive".into());
    }
    if root.is_some() && !latest {
        return Err("--results-root requires --latest".into());
    }
    let selected = if latest {
        vec![PathBuf::from(root.unwrap_or_else(|| ".sevro/results".into())).join("latest.json")]
    } else {
        if files.iter().any(|path| path.trim().is_empty()) {
            return Err("--result-file must name a readable retained result file".into());
        }
        files.into_iter().map(PathBuf::from).collect()
    };
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for path in selected {
        let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
        if !seen.insert(canonical.clone()) {
            return Err("report needs distinct result files".into());
        }
        paths.push(canonical);
    }
    if paths.is_empty() {
        return Err("report needs distinct result files".into());
    }
    Ok(paths)
}

fn value(options: &mut std::slice::Iter<'_, String>, option: &str) -> ReportResult<String> {
    let value = options
        .next()
        .ok_or_else(|| format!("{option} needs a path"))?;
    if value.starts_with('-') && value != "-" {
        return Err(format!("{option} needs a path"));
    }
    Ok(value.clone())
}
