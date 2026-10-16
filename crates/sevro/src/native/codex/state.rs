pub(super) use super::super::isolation::write_private;
use super::super::isolation::{namespace_directory, private_directory, protected_roots};
use super::{CodexOptions, profile, runtime::EmptyRuntime};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(super) struct State {
    pub root: PathBuf,
    pub namespace: PathBuf,
    pub codex_home: PathBuf,
    pub command_home: PathBuf,
    pub command_temp: PathBuf,
    pub profile_id: String,
    pub environment: BTreeMap<OsString, OsString>,
    pub runtime: Option<EmptyRuntime>,
}

impl State {
    pub fn prepare(options: &CodexOptions, workspace: &Path) -> Result<Self, String> {
        validate_fixture(workspace)?;
        #[cfg(target_os = "linux")]
        let base = PathBuf::from("/var/tmp");
        #[cfg(not(target_os = "linux"))]
        let base = std::env::temp_dir();
        let namespace = fs::canonicalize(base)
            .map_err(|_| "native temporary directory is unavailable")?
            .join("sevro-native-private");
        namespace_directory(&namespace)?;
        let workspace =
            fs::canonicalize(workspace).map_err(|_| "Codex workspace is unavailable")?;
        if namespace.starts_with(&workspace) || workspace.starts_with(&namespace) {
            return Err("native runtime namespace overlaps the fixture workspace".into());
        }
        let root = namespace.join(format!("codex-{}", Uuid::new_v4().simple()));
        private_directory(&root)?;
        let mut state = Self {
            codex_home: root.join("codex-home"),
            command_home: root.join("command-home"),
            command_temp: root.join("command-tmp"),
            root,
            namespace,
            profile_id: format!("sevro_{}", Uuid::new_v4().simple()),
            environment: BTreeMap::new(),
            runtime: None,
        };
        state.prepare_contents(options, &workspace)?;
        Ok(state)
    }

    fn prepare_contents(&mut self, options: &CodexOptions, workspace: &Path) -> Result<(), String> {
        for name in ["codex-home", "home", "tmp", "command-home", "command-tmp"] {
            private_directory(&self.root.join(name))?;
        }
        if let Some(policy) = &options.runtime_policy {
            let runtime = EmptyRuntime::prepare(policy, &self.root)?;
            self.command_home = runtime.home.clone();
            self.command_temp = runtime.temp.clone();
            self.runtime = Some(runtime);
        }
        copy_auth(&options.auth_file, &self.codex_home.join("auth.json"))?;
        let roots = protected_roots(
            &options.project_root,
            &options.results_root,
            &options.protected_roots,
            workspace,
            &self.namespace,
        )?;
        let reads = self.executable_roots(&options.binary, &roots)?;
        let configuration = profile::configuration(self, workspace, &roots, &reads)?;
        write_private(
            &self.codex_home.join("config.toml"),
            configuration.as_bytes(),
        )?;
        for (name, value) in [
            (
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
            ),
            (
                "LANG",
                std::env::var_os("LANG").unwrap_or_else(|| "C".into()),
            ),
            ("HOME", self.root.join("home").into_os_string()),
            ("TMPDIR", self.root.join("tmp").into_os_string()),
            ("CODEX_HOME", self.codex_home.clone().into_os_string()),
            ("NO_COLOR", "1".into()),
        ] {
            self.environment.insert(name.into(), value);
        }
        if self.runtime.is_some() {
            for (name, value) in EmptyRuntime::ENVIRONMENT {
                self.environment.insert(name.into(), value.into());
            }
        }
        Ok(())
    }

    fn executable_roots(
        &self,
        binary: &Path,
        protected: &[PathBuf],
    ) -> Result<Vec<PathBuf>, String> {
        let executables = vec![binary.to_path_buf()];
        #[cfg(target_os = "linux")]
        let executables = {
            let mut executables = executables;
            let helper = binary
                .parent()
                .ok_or("Codex executable has no parent")?
                .join("codex-linux-sandbox");
            let source = if helper.exists() {
                helper
            } else {
                binary.to_path_buf()
            };
            let helper_root = self.root.join("helper");
            private_directory(&helper_root)?;
            std::os::unix::fs::symlink(&source, helper_root.join("codex-linux-sandbox"))
                .map_err(|_| "Codex sandbox helper could not be prepared")?;
            executables.push(source);
            for path in [
                self.codex_home.join("tmp"),
                self.codex_home.join("tmp/arg0"),
            ] {
                private_directory(&path)?;
            }
            executables
        };
        let mut reads = BTreeSet::new();
        for executable in executables {
            let resolved =
                fs::canonicalize(&executable).map_err(|_| "Codex executable is unavailable")?;
            for path in [&executable, &resolved] {
                let parent =
                    fs::canonicalize(path.parent().ok_or("Codex executable has no parent")?)
                        .map_err(|_| "Codex executable directory is unavailable")?;
                if protected.iter().any(|root| parent.starts_with(root)) {
                    return Err("Codex executable resides inside a protected root".into());
                }
                reads.insert(parent);
            }
        }
        #[cfg(target_os = "linux")]
        {
            reads.insert(self.root.join("helper"));
            reads.insert(self.codex_home.join("tmp/arg0"));
        }
        Ok(reads.into_iter().collect())
    }

    pub fn close(self) -> Result<(), String> {
        fs::remove_dir_all(&self.root).map_err(|_| "Codex private state cleanup failed".into())
    }
}

impl Drop for State {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn validate_fixture(workspace: &Path) -> Result<(), String> {
    for name in [".git", ".codex"] {
        match fs::symlink_metadata(workspace.join(name)) {
            Ok(metadata) if name == ".codex" || !metadata.is_dir() => {
                return Err(format!(
                    "fixture {name} configuration is unsupported or not isolated"
                ));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err("Codex fixture metadata is unreadable".into());
            }
            _ => {}
        }
    }
    Ok(())
}

fn copy_auth(source: &Path, target: &Path) -> Result<(), String> {
    let mut bytes = Vec::new();
    let file = fs::File::open(source).map_err(|_| "Codex auth file is unreadable or oversized")?;
    if !file
        .metadata()
        .map_err(|_| "Codex auth metadata is unreadable")?
        .is_file()
    {
        return Err("Codex auth file is unreadable or oversized".into());
    }
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Codex auth file is unreadable or oversized")?;
    if bytes.len() > 1024 * 1024 {
        return Err("Codex auth file is unreadable or oversized".into());
    }
    write_private(target, &bytes)
}
