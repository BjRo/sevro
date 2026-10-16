use super::{RunError, RunResult, identity::hash_json};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[cfg(feature = "native-bundle")]
mod bundle;
mod git;

const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SNAPSHOT_FILES: usize = 4096;

pub(super) struct Request<'a> {
    pub project_root: &'a Path,
    pub excluded_roots: &'a [PathBuf],
    pub runner_digest: Option<&'a str>,
    pub project_digest: Option<&'a str>,
}

pub(super) struct Provenance {
    pub runner: Value,
    pub project: Value,
    pub runner_digest: String,
    pub project_digest: String,
}

pub(super) struct ProvenanceFailure {
    pub exit_code: i32,
    pub error: RunError,
}

impl ProvenanceFailure {
    fn derivation(error: RunError) -> Self {
        Self {
            exit_code: 70,
            error,
        }
    }
}

pub(super) fn resolve(request: Request<'_>) -> Result<Provenance, ProvenanceFailure> {
    let runner_digest = match request.runner_digest {
        Some(digest) => digest.to_owned(),
        None => native_build_digest().map_err(ProvenanceFailure::derivation)?,
    };
    let project = project_provenance(request.project_root, request.excluded_roots)
        .map_err(ProvenanceFailure::derivation)?;
    let project_digest = match request.project_digest {
        Some(digest) => digest.to_owned(),
        None if project["revision"].is_string() => hash_json(&json!({
            "format":"sevro.project.v1","revision":project["revision"],
            "dirtyPatchDigest":project["dirtyPatchDigest"]
        }))
        .map_err(ProvenanceFailure::derivation)?,
        None => project_snapshot(request.project_root, request.excluded_roots)
            .map_err(ProvenanceFailure::derivation)?,
    };
    let runner = json!({
        "source":"package","packageName":"@bjoernrochel/sevro",
        "version":env!("CARGO_PKG_VERSION"),"buildDigest":runner_digest
    });
    Ok(Provenance {
        runner,
        project,
        runner_digest,
        project_digest,
    })
}

fn native_build_digest() -> RunResult<String> {
    let executable = std::env::current_exe()?;
    let mut file = fs::File::open(&executable)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let executable_sha256 = format!("{:x}", digest.finalize());
    #[cfg(feature = "native-bundle")]
    {
        bundle::build_digest(&executable, executable_sha256)
    }
    #[cfg(not(feature = "native-bundle"))]
    hash_json(&json!({
        "format":"sevro.native-build.v1","distribution":"standalone",
        "executableSha256":executable_sha256,"assets":[]
    }))
}

fn project_provenance(root: &Path, excluded: &[PathBuf]) -> RunResult<Value> {
    let identity = git::project(root, excluded)?;
    let root = url::Url::from_file_path(root)
        .map_err(|()| "project root cannot be represented as a file URL".to_string())?;
    Ok(
        json!({"root":root.as_str(),"revision":identity.revision,"dirtyPatchDigest":identity.dirty_patch_digest}),
    )
}

#[derive(Serialize)]
struct ProjectFile {
    path: String,
    sha256: String,
    executable: bool,
}

struct ProjectSnapshot<'a> {
    root: &'a Path,
    excluded: &'a [PathBuf],
    files: Vec<ProjectFile>,
    bytes: u64,
}

impl ProjectSnapshot<'_> {
    fn collect(&mut self, relative: &Path) -> RunResult<()> {
        let absolute = self.root.join(relative);
        if relative == Path::new(".git") || self.excluded.contains(&absolute) {
            return Ok(());
        }
        let metadata = fs::symlink_metadata(&absolute)?;
        if metadata.is_symlink() {
            return Err("project snapshot contains a symbolic link".into());
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(&absolute)? {
                let entry = entry?;
                self.collect(&relative.join(entry.file_name()))?;
            }
            return Ok(());
        }
        if !metadata.is_file() {
            return Err("project snapshot contains a non-file".into());
        }
        self.bytes += metadata.len();
        if self.files.len() >= MAX_SNAPSHOT_FILES || self.bytes > MAX_SNAPSHOT_BYTES {
            return Err("project snapshot exceeds the size limit".into());
        }
        let bytes = fs::read(&absolute)?;
        self.files.push(ProjectFile {
            path: relative
                .to_str()
                .ok_or("project snapshot path is not valid UTF-8")?
                .to_owned(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            executable: metadata.permissions().mode() & 0o111 != 0,
        });
        Ok(())
    }
}

fn project_snapshot(root: &Path, excluded: &[PathBuf]) -> RunResult<String> {
    let mut snapshot = ProjectSnapshot {
        root,
        excluded,
        files: Vec::new(),
        bytes: 0,
    };
    snapshot.collect(Path::new(""))?;
    snapshot
        .files
        .sort_by(|left, right| left.path.encode_utf16().cmp(right.path.encode_utf16()));
    hash_json(&json!({"format":"sevro.project.v1","files":snapshot.files}))
}
