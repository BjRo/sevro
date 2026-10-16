use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub fn command(arguments: &[String]) -> i32 {
    let json = arguments.iter().any(|argument| argument == "--json");
    if arguments.iter().any(|argument| argument != "--json") {
        return failure(json, 64, "demo accepts only --json; run sevro demo --help");
    }
    let prepared = DemoInputs::prepare();
    let inputs = match prepared {
        Ok(inputs) => inputs,
        Err(error) => {
            let error = PreparationFailure {
                directory: std::env::temp_dir(),
                source: error,
            };
            return failure(json, 70, &error.to_string());
        }
    };
    let caller = match std::env::current_dir() {
        Ok(caller) => caller,
        Err(error) => {
            return failure(json, 70, &error.to_string());
        }
    };
    let mut run_arguments = Vec::new();
    if json {
        run_arguments.push("--json".to_owned());
    }
    for (option, path) in [
        ("--case-file", inputs.root.join("graded.json")),
        ("--adapter-module", inputs.root.join("host.ts")),
        ("--project-root", inputs.root.join("project")),
        ("--results-root", caller.join(".sevro/results")),
    ] {
        run_arguments.push(option.to_owned());
        run_arguments.push(path.to_string_lossy().into_owned());
    }
    crate::run::command(&run_arguments)
}

fn failure(json: bool, code: i32, message: &str) -> i32 {
    eprintln!("sevro: {message}");
    if json {
        println!(
            "{}",
            serde_json::json!({
                "format":"sevro.cli-result.v1", "runId":null,
                "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
                "task":{"verdict":"not_assessed"}, "exitCode":code, "evidencePath":null,
                "cases":[], "diagnostic":{
                    "code":if code == 64 { "sevro.invocation.invalid" } else { "sevro.runner.error" },
                    "message":message
                }
            })
        );
    } else {
        println!("execution=not_run grading=not_requested task=not_assessed");
    }
    if code == 64 {
        eprintln!(
            "Correct the named option or input and retry. Run sevro run --help for examples and required options."
        );
    } else {
        eprintln!(
            "Check the reported path and ensure --results-root and --run-state-root are writable directories, then retry."
        );
    }
    code
}

#[derive(Debug)]
struct PreparationFailure {
    directory: PathBuf,
    source: io::Error,
}

impl std::fmt::Display for PreparationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "demo temporary project could not be created under {}; set TMPDIR to a writable directory",
            self.directory.display()
        )
    }
}

impl std::error::Error for PreparationFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

struct DemoInputs {
    root: PathBuf,
}

impl DemoInputs {
    fn prepare() -> io::Result<Self> {
        let root = std::env::temp_dir().join(format!("sevro-demo-{}", uuid::Uuid::new_v4()));
        DirBuilder::new().mode(0o700).create(&root)?;
        let inputs = Self { root };
        DirBuilder::new()
            .mode(0o700)
            .create(inputs.root.join("project"))?;
        write_asset(
            &inputs.root.join("graded.json"),
            include_bytes!("../../../examples/basic/graded.json"),
        )?;
        write_asset(
            &inputs.root.join("host.ts"),
            include_bytes!("../../../examples/basic/host.ts"),
        )?;
        Ok(inputs)
    }
}

fn write_asset(path: &Path, bytes: &[u8]) -> io::Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)
}

impl Drop for DemoInputs {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
