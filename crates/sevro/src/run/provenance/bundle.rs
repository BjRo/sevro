use super::{MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_FILES, RunError, RunResult, hash_json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MANIFEST: &str = "sevro-native-bundle.json";
const ROOT_FILES: [&str; 4] = ["package.json", "README.md", "LICENSE", "CONTRIBUTING.md"];
const ROOT_DIRECTORIES: [&str; 4] = ["docs", "examples", "schemas", "src"];
const REQUIRED_ASSETS: [&str; 7] = [
    "docs/installing.md",
    "examples/basic/graded.json",
    "examples/basic/prompt-only.json",
    "examples/basic/host.ts",
    "schemas/run-evidence-v1.schema.json",
    "schemas/report-v1.schema.json",
    "src/cli.ts",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    executable: String,
    assets: Vec<String>,
}

#[derive(Serialize)]
struct Asset {
    path: String,
    sha256: String,
}

#[derive(Deserialize)]
struct Package {
    name: String,
    version: String,
}

pub(super) fn build_digest(executable: &Path, executable_sha256: String) -> RunResult<String> {
    let bin = executable
        .parent()
        .filter(|path| path.file_name().is_some_and(|name| name == "bin"))
        .filter(|_| executable.file_name().is_some_and(|name| name == "sevro"))
        .ok_or("native bundle executable must be installed at bin/sevro")?;
    let root = bin.parent().ok_or("native bundle root is unavailable")?;
    ordinary_metadata(bin, true)?;
    let manifest_bytes = read_small_file(&root.join(MANIFEST))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| RunError::with_source("native bundle manifest is invalid", error))?;
    validate_manifest(&manifest)?;
    let paths = installed_paths(root)?;
    if paths != manifest.assets {
        return Err("native bundle asset inventory differs from its manifest".into());
    }
    let package: Package = serde_json::from_slice(&read_small_file(&root.join("package.json"))?)
        .map_err(|error| {
            RunError::with_source("native bundle package metadata is invalid", error)
        })?;
    if package.name != "@bjoernrochel/sevro" || package.version != env!("CARGO_PKG_VERSION") {
        return Err("native bundle package identity differs from its executable".into());
    }
    let mut bytes = manifest_bytes.len() as u64;
    let mut assets = vec![Asset {
        path: MANIFEST.into(),
        sha256: format!("{:x}", Sha256::digest(&manifest_bytes)),
    }];
    for path in paths {
        let sha256 = asset_digest(&root.join(&path), &mut bytes)?;
        assets.push(Asset { path, sha256 });
    }
    assets.sort_by(|left, right| left.path.encode_utf16().cmp(right.path.encode_utf16()));
    hash_json(&json!({
        "format":"sevro.native-build.v1", "distribution":"bundle",
        "executableSha256":executable_sha256, "assets":assets
    }))
}

fn validate_manifest(manifest: &Manifest) -> RunResult<()> {
    if manifest.format != "sevro.native-bundle.v1" || manifest.executable != "bin/sevro" {
        return Err("native bundle manifest has an unsupported format or executable".into());
    }
    if manifest.assets.len() >= MAX_SNAPSHOT_FILES {
        return Err("native bundle assets exceed the size limit".into());
    }
    let mut previous: Option<&str> = None;
    for path in &manifest.assets {
        let safe = !path.contains(['\\', '\0'])
            && path.split('/').all(|part| !matches!(part, "" | "." | ".."));
        let allowed = ROOT_FILES.contains(&path.as_str())
            || path
                .split_once('/')
                .is_some_and(|(root, _)| ROOT_DIRECTORIES.contains(&root));
        if !safe || !allowed {
            return Err(
                "native bundle manifest contains an unsafe or undeclared asset path".into(),
            );
        }
        if previous.is_some_and(|left| left.encode_utf16().cmp(path.encode_utf16()).is_ge()) {
            return Err("native bundle manifest assets must be sorted and unique".into());
        }
        previous = Some(path);
    }
    for required in ROOT_FILES.iter().chain(REQUIRED_ASSETS.iter()) {
        if !manifest.assets.iter().any(|path| path == required) {
            return Err(
                format!("native bundle manifest is missing required asset {required}").into(),
            );
        }
    }
    Ok(())
}

fn ordinary_metadata(path: &Path, directory: bool) -> RunResult<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        RunError::with_source("native bundle required path is unavailable", error)
    })?;
    if metadata.is_symlink() || (directory && !metadata.is_dir()) {
        return Err("native bundle contains a symbolic link or invalid directory".into());
    }
    if !directory && !metadata.is_file() {
        return Err("native bundle contains a non-file asset".into());
    }
    Ok(metadata)
}

fn installed_paths(root: &Path) -> RunResult<Vec<String>> {
    let mut files = Vec::new();
    let mut pending = Vec::<PathBuf>::new();
    for path in ROOT_FILES {
        ordinary_metadata(&root.join(path), false)?;
        files.push(path.to_owned());
    }
    for path in ROOT_DIRECTORIES {
        ordinary_metadata(&root.join(path), true)?;
        pending.push(PathBuf::from(path));
    }
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(root.join(&directory))? {
            let entry = entry?;
            let relative = directory.join(entry.file_name());
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() {
                pending.push(relative);
            } else {
                ordinary_metadata(&entry.path(), false)?;
                files.push(
                    relative
                        .to_str()
                        .ok_or("native bundle asset path is not valid UTF-8")?
                        .to_owned(),
                );
                if files.len() >= MAX_SNAPSHOT_FILES {
                    return Err("native bundle assets exceed the size limit".into());
                }
            }
        }
    }
    files.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(files)
}

fn read_small_file(path: &Path) -> RunResult<Vec<u8>> {
    ordinary_metadata(path, false)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_SNAPSHOT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err("native bundle assets exceed the size limit".into());
    }
    Ok(bytes)
}

fn asset_digest(path: &Path, total_bytes: &mut u64) -> RunResult<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            return Ok(format!("{:x}", digest.finalize()));
        }
        *total_bytes += count as u64;
        if *total_bytes > MAX_SNAPSHOT_BYTES {
            return Err("native bundle assets exceed the size limit".into());
        }
        digest.update(&buffer[..count]);
    }
}
