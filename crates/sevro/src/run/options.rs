use super::{RunError, RunResult, manifest};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub(super) struct Options {
    pub run_manifest_file: Option<PathBuf>,
    pub runtime_config_file: Option<PathBuf>,
    pub case_source: CaseSource,
    pub case_source_root: Option<PathBuf>,
    pub case_source_map_file: Option<PathBuf>,
    pub project_root: PathBuf,
    pub config_root: PathBuf,
    pub results_root: PathBuf,
    pub candidate: Candidate,
    pub dry: bool,
    pub runner_digest: Option<String>,
    pub project_digest: Option<String>,
    pub condition: String,
    pub trials: u64,
    pub jobs: u64,
    pub threshold: serde_json::Number,
}

pub(super) enum CaseSource {
    File(PathBuf),
    Extension(crate::extension::Selection),
}

impl CaseSource {
    pub fn file(&self) -> Option<&Path> {
        match self {
            Self::File(path) => Some(path),
            Self::Extension(_) => None,
        }
    }
}

pub(super) enum Candidate {
    Claude {
        binary: PathBuf,
        credential_file: PathBuf,
        model: String,
        effort: String,
    },
    Codex {
        binary: PathBuf,
        auth_file: PathBuf,
        model: String,
        effort: String,
        timeout_ms: u64,
    },
    Adapter {
        module: PathBuf,
    },
}

pub(super) type Values = BTreeMap<String, Vec<String>>;

pub(super) const PATH_SETTINGS: &[&str] = &[
    "case-file",
    "adapter-module",
    "extension-command-file",
    "extension-source-file",
    "extension-configuration-file",
    "extension-redacted-configuration-file",
    "case-source-root",
    "case-source-map-file",
    "codex-bin",
    "codex-auth-file",
    "claude-bin",
    "claude-credential-file",
    "project-root",
    "config-root",
    "results-root",
    "runtime-config-file",
];

pub(super) fn selected<'a>(values: &'a Values, key: &str) -> Option<&'a str> {
    values
        .get(key)
        .and_then(|values| values.last())
        .map(String::as_str)
}

pub(super) fn json_requested(arguments: &[String]) -> bool {
    arguments
        .iter()
        .rev()
        .find_map(|value| match value.as_str() {
            "--json" => Some(true),
            "--no-json" => Some(false),
            _ => None,
        })
        .unwrap_or(false)
}

impl Options {
    pub fn parse(arguments: &[String]) -> RunResult<Self> {
        let values = manifest::merge(parse_values(arguments)?)?;
        if values.contains_key("case-source-root") != values.contains_key("case-source-map-file") {
            return Err("case sources require a root and map file".into());
        }
        if values.contains_key("extension-configuration-file")
            != values.contains_key("extension-redacted-configuration-file")
        {
            return Err("extension configuration requires a redacted file".into());
        }
        let dry = selected(&values, "dry") == Some("true");
        let candidate = candidate(&values)?;
        let project_root =
            canonical_path(Path::new(selected(&values, "project-root").unwrap_or(".")))?;
        let config_root = match selected(&values, "config-root") {
            Some(path) => canonical_path(Path::new(path))?,
            None => project_root.clone(),
        };
        if !project_root.is_dir() || !config_root.is_dir() {
            return Err("--project-root and --config-root must be directories".into());
        }
        let results_root = canonical_path(
            &selected(&values, "results-root")
                .map(PathBuf::from)
                .unwrap_or_else(|| project_root.join(".sevro/results")),
        )?;
        let condition = selected(&values, "condition").unwrap_or("passive");
        if !["passive", "enforced"].contains(&condition) {
            return Err("invalid --condition; use passive or enforced".into());
        }
        let threshold = selected(&values, "threshold")
            .unwrap_or("1")
            .parse::<f64>()
            .map_err(|error| RunError::with_source("invalid --threshold", error))?;
        if !(threshold > 0.0 && threshold <= 1.0) {
            return Err("invalid --threshold; supply a number greater than 0 and at most 1".into());
        }
        let threshold = if threshold == 1.0 {
            1.into()
        } else {
            serde_json::Number::from_f64(threshold).ok_or("invalid --threshold")?
        };
        Ok(Self {
            run_manifest_file: selected(&values, "run-manifest-file").map(PathBuf::from),
            runtime_config_file: selected(&values, "runtime-config-file")
                .map(|path| canonical_path(Path::new(path)))
                .transpose()?,
            case_source: case_source(&values)?,
            case_source_root: selected(&values, "case-source-root")
                .map(|path| canonical_path(Path::new(path)))
                .transpose()?,
            case_source_map_file: selected(&values, "case-source-map-file")
                .map(|path| canonical_path(Path::new(path)))
                .transpose()?,
            project_root,
            config_root,
            results_root,
            candidate,
            dry,
            runner_digest: selected(&values, "runner-build-digest")
                .map(|value| digest(value, "runner-build-digest"))
                .transpose()?,
            project_digest: selected(&values, "project-digest")
                .map(|value| digest(value, "project-digest"))
                .transpose()?,
            condition: condition.into(),
            trials: integer(&values, "trials", "1")?,
            jobs: integer(&values, "jobs", "3")?,
            threshold,
        })
    }
}

fn parse_values(arguments: &[String]) -> RunResult<Values> {
    let mut values = Values::new();
    let mut arguments = arguments.iter();
    while let Some(argument) = arguments.next() {
        if argument == "--" {
            if arguments.next().is_some() {
                return Err("expected the run command".into());
            }
            break;
        }
        if let Some(key) = argument.strip_prefix("--no-")
            && ["json", "dry"].contains(&key)
        {
            values.insert(key.into(), vec!["false".into()]);
            continue;
        }
        let Some(option) = argument.strip_prefix("--") else {
            return Err("expected the run command".into());
        };
        if ["json", "dry"].contains(&option) {
            values.insert(option.into(), vec!["true".into()]);
            continue;
        }
        let (key, inline) = option
            .split_once('=')
            .map_or((option, None), |(key, value)| (key, Some(value)));
        if ![
            "run-manifest-file",
            "runtime-config-file",
            "adapter-module",
            "extension-command-file",
            "extension-configuration-file",
            "extension-redacted-configuration-file",
            "extension-source-file",
            "case-id",
            "case-file",
            "case-source-root",
            "case-source-map-file",
            "host",
            "codex-bin",
            "codex-auth-file",
            "codex-timeout-ms",
            "claude-bin",
            "claude-credential-file",
            "model",
            "effort",
            "project-root",
            "config-root",
            "results-root",
            "runner-build-digest",
            "project-digest",
            "condition",
            "trials",
            "jobs",
            "threshold",
        ]
        .contains(&key)
        {
            return Err(format!("invalid CLI arguments: unknown option --{key}").into());
        }
        let value = inline
            .or_else(|| arguments.next().map(String::as_str))
            .filter(|value| inline.is_some() || !value.starts_with("--"))
            .ok_or_else(|| format!("invalid CLI arguments: --{key} requires a value"))?;
        if value.is_empty() && !matches!(key, "runner-build-digest" | "project-digest") {
            return Err(if matches!(key, "adapter-module" | "host") {
                "missing --adapter-module or --host".into()
            } else if key == "codex-timeout-ms" {
                "invalid Codex host configuration".into()
            } else {
                format!("missing --{key}; supply --{key} with a value").into()
            });
        }
        if key == "extension-source-file" {
            values.entry(key.into()).or_default().push(value.into());
        } else {
            values.insert(key.into(), vec![value.into()]);
        }
    }
    Ok(values)
}

fn required<'a>(values: &'a Values, key: &str) -> RunResult<&'a str> {
    selected(values, key)
        .ok_or_else(|| format!("missing --{key}; supply --{key} with a value").into())
}

fn digest(value: &str, key: &str) -> RunResult<String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("--{key} must be a 64-character SHA-256 digest").into());
    }
    Ok(value.into())
}

fn integer(values: &Values, key: &str, default: &str) -> RunResult<u64> {
    let value = selected(values, key)
        .unwrap_or(default)
        .parse::<f64>()
        .map_err(|error| {
            RunError::with_source(format!("invalid --{key}; supply a positive integer"), error)
        })?;
    if !(1.0..=9_007_199_254_740_991.0).contains(&value) || value.fract() != 0.0 {
        return Err(format!("invalid --{key}; supply a positive integer").into());
    }
    Ok(value as u64)
}

fn candidate(values: &Values) -> RunResult<Candidate> {
    if let Some(module) = selected(values, "adapter-module") {
        if values.contains_key("host") {
            return Err("--host and --adapter-module are exclusive".into());
        }
        if values.contains_key("model") || values.contains_key("effort") {
            return Err("--model and --effort require a built-in host".into());
        }
        if ["codex-bin", "codex-auth-file", "codex-timeout-ms"]
            .iter()
            .any(|key| values.contains_key(*key))
        {
            return Err("Codex options require a Codex host route".into());
        }
        if ["claude-bin", "claude-credential-file"]
            .iter()
            .any(|key| values.contains_key(*key))
        {
            return Err("Claude options require a Claude host route".into());
        }
        return Ok(Candidate::Adapter {
            module: canonical_path(Path::new(module))?,
        });
    }
    match selected(values, "host") {
        Some("codex") => {}
        Some("claude") => {
            if ["codex-bin", "codex-auth-file", "codex-timeout-ms"]
                .iter()
                .any(|key| values.contains_key(*key))
            {
                return Err("Codex options require a Codex host route".into());
            }
            return Ok(Candidate::Claude {
                binary: canonical_path(Path::new(required(values, "claude-bin")?))?,
                credential_file: canonical_path(Path::new(required(
                    values,
                    "claude-credential-file",
                )?))?,
                model: required(values, "model")?.into(),
                effort: required(values, "effort")?.into(),
            });
        }
        Some(_) => return Err("this Rust dry-run slice currently requires --host codex".into()),
        None => return Err("missing --adapter-module or --host".into()),
    }
    if ["claude-bin", "claude-credential-file"]
        .iter()
        .any(|key| values.contains_key(*key))
    {
        return Err("Claude options require a Claude host route".into());
    }
    let binary = match selected(values, "codex-bin") {
        Some(path) => canonical_path(Path::new(path))?,
        None => native_binary("codex")?,
    };
    let auth_file = canonical_path(Path::new(required(values, "codex-auth-file")?))?;
    let timeout_ms = integer(values, "codex-timeout-ms", "600000")?;
    if timeout_ms > 1_800_000 {
        return Err("invalid --codex-timeout-ms; supply an integer from 1 to 1800000".into());
    }
    Ok(Candidate::Codex {
        binary,
        auth_file,
        model: required(values, "model")?.into(),
        effort: required(values, "effort")?.into(),
        timeout_ms,
    })
}

fn case_source(values: &Values) -> RunResult<CaseSource> {
    match (
        selected(values, "case-file"),
        selected(values, "extension-command-file"),
    ) {
        (Some(path), None) => {
            if values.contains_key("case-id")
                || values.contains_key("extension-configuration-file")
                || values
                    .get("extension-source-file")
                    .is_some_and(|sources| !sources.is_empty())
            {
                return Err("extension options require --extension-command-file".into());
            }
            Ok(CaseSource::File(canonical_path(Path::new(path))?))
        }
        (None, Some(command)) => {
            let case_id = required(values, "case-id")?.into();
            let sources = values
                .get("extension-source-file")
                .filter(|sources| !sources.is_empty())
                .ok_or("missing --extension-source-file")?;
            let source_files = sources
                .iter()
                .map(|path| canonical_path(Path::new(path)))
                .collect::<RunResult<_>>()?;
            Ok(CaseSource::Extension(crate::extension::Selection {
                command_file: canonical_path(Path::new(command))?,
                source_files,
                case_id,
                configuration_file: selected(values, "extension-configuration-file")
                    .map(|path| canonical_path(Path::new(path)))
                    .transpose()?,
                redacted_configuration_file: selected(
                    values,
                    "extension-redacted-configuration-file",
                )
                .map(|path| canonical_path(Path::new(path)))
                .transpose()?,
            }))
        }
        _ => Err("select exactly one of --case-file or --extension-command-file".into()),
    }
}

pub(super) fn canonical_path(path: &Path) -> RunResult<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            part => normalized.push(part),
        }
    }
    canonical_missing(&normalized)
}

fn canonical_missing(path: &Path) -> RunResult<PathBuf> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let Some(parent) = path.parent() else {
                return Err(error.into());
            };
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_symlink() => {
                    let target = fs::read_link(path)?;
                    return canonical_path(&parent.join(target));
                }
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(RunError::with_source(
                        format!("cannot resolve {}: {error}", path.display()),
                        error,
                    ));
                }
                _ => {}
            }
            let Some(name) = path.file_name() else {
                return Err(error.into());
            };
            Ok(canonical_missing(parent)?.join(name))
        }
        Err(error) => Err(RunError::with_source(
            format!("cannot resolve {}: {error}", path.display()),
            error,
        )),
    }
}

fn native_binary(name: &str) -> RunResult<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = directory.join(name);
        if let Ok(metadata) = fs::metadata(&path)
            && metadata.is_file()
            && metadata.permissions().mode() & 0o111 != 0
        {
            return canonical_path(&path);
        }
    }
    Err(format!(
        "selected {name} executable was not found on PATH; install {name} or supply --{name}-bin <path>"
    ).into())
}
