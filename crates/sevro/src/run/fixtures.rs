mod artifacts;
mod generated;
mod repository;
mod setup;
mod sources;
mod tools;

pub(super) use artifacts::ArtifactDeclaration;
pub(super) use generated::GeneratedFixture;
pub(super) use setup::{FixtureSetup, FixtureSetupInput};

use super::{RunResult, options::Options, preparation::FixtureDeclaration, storage};
use crate::cancellation::Cancellation;
use repository::RepositorySource;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(super) struct PreparedFixture {
    kind: PreparedKind,
    setup: Option<FixtureSetup>,
    project_root: PathBuf,
    artifacts: Vec<artifacts::Artifact>,
}

enum PreparedKind {
    Generated(GeneratedFixture),
    Inline {
        files: BTreeMap<String, String>,
    },
    Repository {
        source: RepositorySource,
        files: Option<BTreeMap<String, String>>,
        staged: Option<Vec<String>>,
    },
}

impl PreparedFixture {
    pub(super) fn protected_roots(&self) -> Vec<PathBuf> {
        match &self.kind {
            PreparedKind::Inline { .. } | PreparedKind::Generated(_) => Vec::new(),
            PreparedKind::Repository { source, .. } => source.protected_roots(),
        }
    }

    pub(super) fn identity(&self) -> Value {
        let mut identity = match &self.kind {
            PreparedKind::Generated(fixture) => json!(fixture),
            PreparedKind::Inline { files } => json!({"files":files,"artifacts":[]}),
            PreparedKind::Repository {
                source,
                files,
                staged,
            } => {
                let mut identity = json!({
                    "kind":"repository","sourceRef":source.reference,
                    "revision":source.revision,"artifacts":[]
                });
                if let Some(files) = files {
                    identity["files"] = json!(files);
                }
                if let Some(staged) = staged {
                    identity["staged"] = json!(staged);
                }
                identity
            }
        };
        if let Some(setup) = self.setup_configuration() {
            identity["fixtureSetup"] = setup;
        }
        identity["artifacts"] = json!(
            self.artifacts
                .iter()
                .map(artifacts::Artifact::identity)
                .collect::<Vec<_>>()
        );
        identity
    }

    pub(super) fn setup_configuration(&self) -> Option<Value> {
        self.setup.as_ref().map(|setup| json!(setup))
    }

    pub(super) fn retain_artifacts(&self, run_directory: &Path) -> RunResult<Vec<Value>> {
        artifacts::retain(&self.artifacts, run_directory)
    }
}

pub(super) struct ResolvedFixture {
    kind: PreparedKind,
    sources: Option<sources::Sources>,
    fixture_paths: Vec<String>,
}

pub(super) fn resolve(
    options: &Options,
    declaration: &FixtureDeclaration,
) -> RunResult<ResolvedFixture> {
    let sources = sources::read(options)?;
    let kind = match declaration {
        FixtureDeclaration::Generated(fixture) => PreparedKind::Generated(fixture.clone()),
        FixtureDeclaration::Inline { files } => PreparedKind::Inline {
            files: files.clone(),
        },
        FixtureDeclaration::Repository {
            source_ref,
            files,
            staged,
        } => PreparedKind::Repository {
            source: repository::resolve(sources.as_ref(), source_ref)?,
            files: files.clone(),
            staged: staged.clone(),
        },
    };
    let fixture_paths = match declaration {
        FixtureDeclaration::Generated(fixture) => fixture.paths(),
        FixtureDeclaration::Inline { files } => files.keys().cloned().collect::<Vec<_>>(),
        FixtureDeclaration::Repository { files, .. } => files
            .as_ref()
            .map(|files| files.keys().cloned().collect())
            .unwrap_or_default(),
    };
    Ok(ResolvedFixture {
        kind,
        sources,
        fixture_paths,
    })
}

pub(super) fn prepare(
    options: &Options,
    resolved: ResolvedFixture,
    setup: Option<&FixtureSetup>,
    artifact_declarations: &[ArtifactDeclaration],
) -> RunResult<PreparedFixture> {
    let ResolvedFixture {
        kind,
        sources,
        fixture_paths,
    } = resolved;
    if setup.is_some() && matches!(kind, PreparedKind::Inline { .. }) {
        return Err("fixture setup requires a Git fixture".into());
    }
    let artifacts = artifacts::prepare(
        artifact_declarations,
        &fixture_paths,
        !matches!(kind, PreparedKind::Inline { .. }),
        sources.as_ref(),
    )?;
    Ok(PreparedFixture {
        kind,
        setup: setup.cloned(),
        project_root: options.project_root.clone(),
        artifacts,
    })
}

pub(super) fn validate_repository_overlay(
    files: Option<&BTreeMap<String, String>>,
    staged: &[String],
) -> RunResult<()> {
    repository::validate_overlay(files, staged)
}

pub(super) struct Materialized {
    pub workspace: PathBuf,
    pub cancelled: bool,
}

pub(super) fn materialize(
    fixture: &PreparedFixture,
    cancellation: &Cancellation,
) -> RunResult<Materialized> {
    let workspace = allocate_workspace()?;
    let result = (|| {
        if cancellation.is_cancelled() {
            return Ok(true);
        }
        match &fixture.kind {
            PreparedKind::Generated(fixture) => fixture.materialize(&workspace)?,
            PreparedKind::Inline { files } => write_inline_files(files, &workspace)?,
            PreparedKind::Repository {
                source,
                files,
                staged,
            } => {
                repository::clone(source, &workspace)?;
                if let Some(files) = files {
                    repository::apply_overlay(
                        files,
                        staged.as_deref().unwrap_or_default(),
                        &workspace,
                    )?;
                }
            }
        }
        if let Some(setup) = &fixture.setup
            && setup.run(&workspace, &fixture.project_root, cancellation)?
                == setup::Outcome::Cancelled
        {
            return Ok(true);
        }
        if cancellation.is_cancelled() {
            return Ok(true);
        }
        artifacts::mount(&fixture.artifacts, &workspace)?;
        Ok(cancellation.is_cancelled())
    })();
    // An admitted workspace remains available when materialization fails.
    result.map(|cancelled| Materialized {
        workspace,
        cancelled,
    })
}

fn allocate_workspace() -> RunResult<PathBuf> {
    let temporary = if cfg!(target_os = "linux") {
        PathBuf::from("/var/tmp")
    } else {
        std::env::temp_dir()
    };
    let parent = fs::canonicalize(temporary)?.join("sevro-workspaces-private");
    storage::private_directory(&parent)?;
    let metadata = fs::symlink_metadata(&parent)?;
    if !metadata.is_dir() || metadata.mode() & 0o077 != 0 {
        return Err("workspace namespace must be an owned private directory".into());
    }
    let workspace = parent.join(format!("case-{}", Uuid::new_v4().simple()));
    storage::new_directory(&workspace)?;
    let created = fs::symlink_metadata(&workspace)?;
    if created.uid() != metadata.uid() {
        let _ = fs::remove_dir(&workspace);
        return Err("workspace namespace must be an owned private directory".into());
    }
    Ok(workspace)
}

fn write_inline_files(
    files: &BTreeMap<String, String>,
    workspace: &std::path::Path,
) -> RunResult<()> {
    for (path, content) in files {
        let target = workspace.join(path);
        storage::private_directory(target.parent().ok_or("fixture file has no parent")?)?;
        storage::write_private(&target, content.as_bytes())?;
    }
    Ok(())
}
