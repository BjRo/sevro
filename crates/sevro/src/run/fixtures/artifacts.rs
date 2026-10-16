use super::super::{RunError, RunResult, identity::sha256, preparation::fixture_path, storage};
use super::sources::Sources;
use data_encoding::BASE64;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const MAX_ARTIFACT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::run) struct ArtifactDeclaration {
    id: String,
    relative_path: String,
    sha256: String,
    content_base64: Option<String>,
    source_ref: Option<String>,
    #[serde(default)]
    git_exclude: bool,
    #[serde(default)]
    executable: bool,
}

pub(super) struct Artifact {
    declaration: ArtifactDeclaration,
    bytes: Vec<u8>,
}

impl Artifact {
    pub(super) fn identity(&self) -> Value {
        let mut value = self.reference();
        value["relativePath"] = json!(self.declaration.relative_path);
        value
    }

    fn reference(&self) -> Value {
        let mut value = json!({"id":self.declaration.id,"sha256":self.declaration.sha256});
        if self.declaration.git_exclude {
            value["gitExclude"] = json!(true);
        }
        if self.declaration.executable {
            value["executable"] = json!(true);
        }
        value
    }

    fn write(&self, root: &Path) -> RunResult<()> {
        let path = unused_target(root, &self.declaration.relative_path)?;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(if self.declaration.executable {
                0o700
            } else {
                0o600
            })
            .open(path)
            .and_then(|mut file| file.write_all(&self.bytes))
            .map_err(|error| {
                RunError::with_source(format!("cannot write preparation artifact: {error}"), error)
            })
    }
}

pub(super) fn prepare(
    declarations: &[ArtifactDeclaration],
    fixture_paths: &[String],
    is_git: bool,
    sources: Option<&Sources>,
) -> RunResult<Vec<Artifact>> {
    let mut declarations = declarations.to_vec();
    resolve_sources(&mut declarations, sources)?;
    let mut paths = fixture_paths.to_vec();
    paths.extend(declarations.iter().map(|item| item.relative_path.clone()));
    validate_paths(&paths)?;
    let mut ids = BTreeSet::new();
    let mut total = 0usize;
    declarations
        .into_iter()
        .map(|declaration| {
            // The wire schema requires nonempty IDs; uniqueness spans declarations.
            if !ids.insert(declaration.id.clone()) {
                return Err("preparation artifact IDs must be unique and nonempty".into());
            }
            if declaration.git_exclude
                && declaration
                    .relative_path
                    .chars()
                    .any(|character| character < ' ' || character == '\u{7f}')
            {
                return Err("Git-excluded artifact path contains control characters".into());
            }
            let encoded = declaration
                .content_base64
                .as_ref()
                .expect("validated artifact has inline or resolved source bytes");
            // The pinned BASE64 decoder enforces canonical padding and zero trailing bits.
            let bytes = BASE64.decode(encoded.as_bytes()).map_err(|error| {
                RunError::with_source(
                    "preparation artifact content is not canonical base64",
                    error,
                )
            })?;
            total = total.saturating_add(bytes.len());
            require_size(bytes.len() as u64, total as u64)?;
            if sha256(&bytes) != declaration.sha256 {
                return Err("preparation artifact digest does not match content".into());
            }
            if is_git
                && declaration
                    .relative_path
                    .split('/')
                    .any(|part| part.eq_ignore_ascii_case(".git"))
            {
                return Err("preparation artifacts cannot modify repository metadata".into());
            }
            if declaration.git_exclude && !is_git {
                return Err("Git-excluded preparation artifacts require a Git fixture".into());
            }
            Ok(Artifact { declaration, bytes })
        })
        .collect()
}

fn resolve_sources(
    declarations: &mut [ArtifactDeclaration],
    sources: Option<&Sources>,
) -> RunResult<()> {
    if !declarations
        .iter()
        .any(|declaration| declaration.source_ref.is_some())
    {
        return Ok(());
    }
    let sources = sources.ok_or("preparation source root is required and must be absolute")?;
    let root = fs::canonicalize(&sources.root)
        .map_err(|error| RunError::with_source("preparation source root is unreadable", error))?;
    let mut total = 0u64;
    for declaration in declarations {
        let Some(reference) = declaration.source_ref.take() else {
            continue;
        };
        let location = sources
            .refs
            .get(&reference)
            .ok_or("preparation source reference is not declared")?;
        let path = url::Url::parse(location)
            .map_err(|error| RunError::with_source("preparation source is unreadable", error))?
            .to_file_path()
            .map_err(|()| "preparation source is unreadable")?;
        let path = fs::canonicalize(path)
            .map_err(|error| RunError::with_source("preparation source is unreadable", error))?;
        if path == root || !path.starts_with(&root) {
            return Err("preparation source escapes its declared root".into());
        }
        let size = fs::metadata(&path)
            .map_err(|error| RunError::with_source("preparation source is unreadable", error))?
            .len();
        require_size(size, total.saturating_add(size))?;
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|error| RunError::with_source("preparation source is unreadable", error))?
            .take(MAX_ARTIFACT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| RunError::with_source("preparation source is unreadable", error))?;
        total = total.saturating_add(bytes.len() as u64);
        require_size(bytes.len() as u64, total)?;
        declaration.content_base64 = Some(BASE64.encode(&bytes));
    }
    Ok(())
}

fn require_size(bytes: u64, total: u64) -> RunResult<()> {
    if bytes > MAX_ARTIFACT_BYTES || total > MAX_TOTAL_BYTES {
        return Err("preparation artifacts exceed the size limit".into());
    }
    Ok(())
}

fn validate_paths(paths: &[String]) -> RunResult<()> {
    let mut normalized = Vec::<String>::new();
    for path in paths {
        fixture_path(path)?;
        let path = path.to_lowercase();
        if normalized.iter().any(|other| {
            path == *other
                || path.starts_with(&format!("{other}/"))
                || other.starts_with(&format!("{path}/"))
        }) {
            return Err("fixture paths collide".into());
        }
        normalized.push(path);
    }
    Ok(())
}

pub(super) fn mount(artifacts: &[Artifact], workspace: &Path) -> RunResult<()> {
    for artifact in artifacts {
        artifact.write(workspace)?;
    }
    let excluded: Vec<String> = artifacts
        .iter()
        .filter(|artifact| artifact.declaration.git_exclude)
        .map(|artifact| {
            artifact
                .declaration
                .relative_path
                .chars()
                .map(|character| {
                    if "\\*?[]#! ".contains(character) {
                        format!("\\{character}")
                    } else {
                        character.to_string()
                    }
                })
                .collect()
        })
        .collect();
    if !excluded.is_empty() {
        let patterns = format!(
            "\n{}\n",
            excluded
                .iter()
                .map(|path| format!("/{path}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        OpenOptions::new()
            .append(true)
            .create(true)
            .open(workspace.join(".git/info/exclude"))
            .and_then(|mut file| file.write_all(patterns.as_bytes()))
            .map_err(|error| {
                RunError::with_source(
                    format!("cannot exclude preparation artifacts: {error}"),
                    error,
                )
            })?;
    }
    Ok(())
}

pub(super) fn retain(artifacts: &[Artifact], run_directory: &Path) -> RunResult<Vec<Value>> {
    if artifacts.is_empty() {
        return Ok(Vec::new());
    }
    let directory = run_directory.join("prepared");
    storage::new_directory(&directory)?;
    artifacts
        .iter()
        .map(|artifact| {
            artifact.write(&directory)?;
            let mut reference = artifact.reference();
            reference["path"] = json!(
                url::Url::from_file_path(directory.join(&artifact.declaration.relative_path))
                    .map_err(|()| "invalid retained artifact path")?
                    .as_str()
            );
            Ok(reference)
        })
        .collect()
}

fn unused_target(root: &Path, path: &str) -> RunResult<PathBuf> {
    let mut components = path.split('/').peekable();
    let mut target = root.to_path_buf();
    while let Some(component) = components.next() {
        target.push(component);
        let parent = components.peek().is_some();
        match fs::symlink_metadata(&target) {
            Ok(entry) if parent && !entry.is_dir() => {
                return Err("preparation artifact traverses a non-directory".into());
            }
            Ok(_) if !parent => return Err("preparation artifact path already exists".into()),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if parent {
                    storage::new_directory(&target)?;
                }
            }
            Err(error) => {
                return Err(RunError::with_source(
                    format!("cannot inspect preparation artifact: {error}"),
                    error,
                ));
            }
        }
    }
    Ok(target)
}
