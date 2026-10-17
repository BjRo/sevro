use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct EmptyDirectory(PathBuf);

impl EmptyDirectory {
    fn new() -> Self {
        let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("sevro-rust-cli-{}-{sequence}", std::process::id()));
        fs::create_dir(&path).expect("create isolated invocation directory");
        Self(path)
    }
}

impl Drop for EmptyDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove isolated invocation directory");
    }
}

fn invoke_without_writes(args: &[&str]) -> Output {
    let directory = EmptyDirectory::new();
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .args(args)
        .current_dir(&directory.0)
        .output()
        .expect("execute sevro binary");
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    output
}

fn successful_text(args: &[&str]) -> String {
    let output = invoke_without_writes(args);
    assert_eq!(output.status.code(), Some(0), "arguments: {args:?}");
    assert!(output.stderr.is_empty(), "arguments: {args:?}");
    String::from_utf8(output.stdout).expect("UTF-8 help")
}

#[test]
fn top_level_help_has_examples_before_commands_without_preparing_a_run() {
    for args in [&[][..], &["--help"][..], &["-h"][..], &["help"][..]] {
        let help = successful_text(args);
        assert!(help.contains("Usage: sevro"));
        assert!(help.contains("sevro run --case-file"));
        assert!(help.contains("sevro report --result-file"));
        assert!(help.find("Examples:").unwrap() < help.find("Commands:").unwrap());
        assert!(help.contains("sevro run --help"));
        assert!(help.contains("--version"));
    }
}

#[test]
fn run_help_explains_required_options_defaults_and_paths_without_preparing_a_run() {
    for args in [["run", "--help"], ["run", "-h"], ["help", "run"]] {
        let help = successful_text(&args);
        assert!(help.find("Examples:").unwrap() < help.find("Required:").unwrap());
        for option in [
            "--case-file",
            "--extension-command-file",
            "--host",
            "--adapter-module",
            "--project-root",
            "--results-root",
            "--condition",
            "--trials",
            "--threshold",
            "--jobs <integer> (default: 3)",
            "--config-root <path> (default: --project-root)",
            "--run-state-root <path> (default: --results-root)",
            "Relative run paths resolve from the current directory",
            "--dry",
            "--json",
        ] {
            assert!(help.contains(option), "missing {option}");
        }
    }
}

#[test]
fn version_reports_the_installed_package_version_without_preparing_a_run() {
    let package: serde_json::Value =
        serde_json::from_str(include_str!("../../../package.json")).unwrap();
    for option in ["--version", "-v"] {
        assert_eq!(
            successful_text(&[option]),
            format!("sevro {}\n", package["version"].as_str().unwrap())
        );
    }
}

#[test]
fn report_help_explains_inputs_and_output_without_reading_results() {
    for args in [["report", "--help"], ["report", "-h"], ["help", "report"]] {
        let help = successful_text(&args);
        assert!(help.find("Examples:").unwrap() < help.find("Required:").unwrap());
        for detail in [
            "--result-file <path>",
            "absolute",
            "Markdown by default",
            "sevro.report.v1",
        ] {
            assert!(help.contains(detail), "missing {detail}");
        }
    }
}

#[test]
fn init_help_explains_safe_templates_without_creating_files() {
    for args in [["init", "--help"], ["init", "-h"], ["help", "init"]] {
        let help = successful_text(&args);
        for detail in [
            "response|repository-skill|coding",
            "refuses existing paths",
            "--codex-auth-file",
            "sevro report --latest",
        ] {
            assert!(help.contains(detail), "missing {detail}");
        }
    }
}

#[test]
fn demo_help_explains_owned_inputs_without_preparing_a_run() {
    for args in [["demo", "--help"], ["demo", "-h"], ["help", "demo"]] {
        let help = successful_text(&args);
        for detail in [
            "Usage: sevro demo [--json]",
            ".sevro/results",
            "without model credentials",
        ] {
            assert!(help.contains(detail), "missing {detail}");
        }
    }
}

#[test]
fn invalid_command_reports_unassessed_result_and_honors_last_output_selection() {
    for (args, json) in [
        (vec!["nonsense"], false),
        (vec!["nonsense", "--json"], true),
        (vec!["nonsense", "--json", "--no-json"], false),
        (vec!["nonsense", "--no-json", "--json"], true),
    ] {
        let output = invoke_without_writes(&args);
        assert_eq!(output.status.code(), Some(64));
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            "sevro: expected the run command\nCorrect the named option or input and retry. Run sevro run --help for examples and required options.\n"
        );
        if json {
            let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                result,
                serde_json::json!({
                    "format": "sevro.cli-result.v1",
                    "runId": null,
                    "execution": {"status": "not_run"},
                    "grading": {"status": "not_requested"},
                    "task": {"verdict": "not_assessed"},
                    "exitCode": 64,
                    "evidencePath": null,
                    "cases": [],
                    "diagnostic": {"code": "sevro.invocation.invalid", "message": "expected the run command"}
                })
            );
        } else {
            assert_eq!(
                output.stdout,
                b"execution=not_run grading=not_requested task=not_assessed\n"
            );
        }
    }
}
