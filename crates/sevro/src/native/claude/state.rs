use super::super::isolation::{
    namespace_directory, private_directory, protected_roots, write_private,
};
use super::{ClaudeOptions, settings};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(super) struct State {
    root: PathBuf,
    pub settings: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
}

impl State {
    pub fn prepare(options: &ClaudeOptions, workspace: &Path) -> Result<Self, String> {
        let workspace =
            fs::canonicalize(workspace).map_err(|_| "Claude workspace is unavailable")?;
        #[cfg(target_os = "linux")]
        let base = PathBuf::from("/var/tmp");
        #[cfg(not(target_os = "linux"))]
        let base = std::env::temp_dir();
        let namespace = fs::canonicalize(base)
            .map_err(|_| "native temporary directory is unavailable")?
            .join("sevro-native-private");
        namespace_directory(&namespace)?;
        if namespace.starts_with(&workspace) || workspace.starts_with(&namespace) {
            return Err("native runtime namespace overlaps the fixture workspace".into());
        }
        require_runtime_namespace(&namespace)?;
        let root = namespace.join(format!("claude-{}", Uuid::new_v4().simple()));
        private_directory(&root)?;
        let mut state = Self {
            settings: root.join("private/settings.json"),
            root,
            environment: BTreeMap::new(),
        };
        state.prepare_contents(options, &workspace, &namespace)?;
        Ok(state)
    }

    fn prepare_contents(
        &mut self,
        options: &ClaudeOptions,
        workspace: &Path,
        namespace: &Path,
    ) -> Result<(), String> {
        let private = self.root.join("private");
        let config = private.join("config");
        for path in [
            &private,
            &config,
            &self.root.join("home"),
            &self.root.join("tmp"),
        ] {
            private_directory(path)?;
        }
        let credential = config.join(".credentials.json");
        copy_credential(&options.credential_file, &credential)?;
        let roots = protected_roots(
            &options.project_root,
            &options.results_root,
            &options.protected_roots,
            workspace,
            namespace,
        )?;
        let roots: Vec<PathBuf> = roots
            .iter()
            .filter(|root| {
                !roots
                    .iter()
                    .any(|other| other != *root && root.starts_with(other))
            })
            .cloned()
            .collect();
        if roots
            .iter()
            .any(|root| root != namespace && credential.starts_with(root))
        {
            return Err("Claude private state overlaps a protected root".into());
        }
        let binary =
            fs::canonicalize(&options.binary).map_err(|_| "Claude executable is unavailable")?;
        if roots.iter().any(|root| binary.starts_with(root)) {
            return Err("Claude executable resides inside a protected root".into());
        }
        let settings = settings::create(&private, &credential, &roots, workspace)?;
        write_private(
            &self.settings,
            &serde_json::to_vec(&settings).map_err(|_| "Claude settings could not be encoded")?,
        )?;
        let runtime = prepare_command_runtime(workspace)?;
        for (name, value) in [
            (
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
            ),
            (
                "LANG",
                std::env::var_os("LANG").unwrap_or_else(|| "C".into()),
            ),
            ("HOME", runtime.join("home").into_os_string()),
            ("TMPDIR", runtime.join("tmp").into_os_string()),
            ("CLAUDE_CONFIG_DIR", config.into_os_string()),
            ("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1".into()),
            ("NO_COLOR", "1".into()),
        ] {
            self.environment.insert(name.into(), value);
        }
        Ok(())
    }

    pub fn close(self) -> Result<(), String> {
        fs::remove_dir_all(&self.root).map_err(|_| "Claude private state cleanup failed".into())
    }
}

impl Drop for State {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn prepare_command_runtime(workspace: &Path) -> Result<PathBuf, String> {
    let git = workspace.join(".git");
    match fs::symlink_metadata(&git) {
        Ok(metadata) if metadata.is_dir() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => private_directory(&git)?,
        _ => return Err("Claude fixture Git metadata is unsupported or not isolated".into()),
    }
    let runtime = git.join("sevro-runtime");
    namespace_directory(&runtime)?;
    let candidate = runtime.join("candidate");
    namespace_directory(&candidate)?;
    for name in ["home", "tmp"] {
        namespace_directory(&candidate.join(name))?;
    }
    Ok(candidate)
}

fn require_runtime_namespace(namespace: &Path) -> Result<(), String> {
    for implicit in ["/tmp/claude", "/private/tmp/claude"] {
        let root = Path::new(implicit);
        let mut roots = vec![root.to_path_buf()];
        match fs::canonicalize(root) {
            Ok(path) => roots.push(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Claude implicit native writable root is unreadable".into()),
        }
        if roots
            .iter()
            .any(|root| namespace.starts_with(root) || root.starts_with(namespace))
        {
            return Err("Claude namespace overlaps an implicit native writable root".into());
        }
    }
    Ok(())
}

fn copy_credential(source: &Path, target: &Path) -> Result<(), String> {
    let file =
        fs::File::open(source).map_err(|_| "Claude credential file is unreadable or oversized")?;
    if !file
        .metadata()
        .map_err(|_| "Claude credential metadata is unreadable")?
        .is_file()
    {
        return Err("Claude credential file is unreadable or oversized".into());
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Claude credential file is unreadable or oversized")?;
    if bytes.len() > 1024 * 1024 || String::from_utf8_lossy(&bytes).trim().is_empty() {
        return Err("Claude credential file is empty or oversized".into());
    }
    write_private(target, &bytes)
}
