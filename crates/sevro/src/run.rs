mod error;
mod extension_context;
mod fixtures;
mod graders;
mod host;
mod identity;
mod manifest;
mod options;
mod preparation;
mod provenance;
mod records;
mod runtime_config;
mod storage;

use crate::formatting::fixed;
use error::RunError;
use options::{CaseSource, Options};
use preparation::PreparedCase;
use serde_json::{Value, json};

type RunResult<T> = Result<T, RunError>;

pub fn command(arguments: &[String]) -> i32 {
    let json = options::json_requested(arguments);
    let options = match Options::parse(arguments) {
        Ok(options) => options,
        Err(error) => return failure(json, 64, error.message()),
    };
    let runtime = match runtime_config::load(&options) {
        Ok(runtime) => runtime,
        Err(error) => return failure(json, 64, error.message()),
    };
    let cancellation = match crate::cancellation::CommandCancellation::register() {
        Ok(cancellation) => cancellation,
        Err(message) => return failure(json, 70, &message),
    };
    let mut host = match host::HostContext::open(&options, cancellation.token()) {
        Ok(host) => host,
        Err(error) => {
            if let Some(signal) = cancellation.token().signal() {
                return 128 + signal;
            }
            return failure(json, 64, error.message());
        }
    };
    let loaded = match &options.case_source {
        CaseSource::File(path) => PreparedCase::read(path)
            .map(|case| (case, None))
            .map_err(identity::PreparationFailure::from),
        CaseSource::Extension(selection) => {
            extension_context::load(&options, selection, &host, cancellation.token())
                .map(|(case, extension)| (case, Some(extension)))
        }
    };
    let (case, extension) = match loaded {
        Ok(loaded) => loaded,
        Err(error) => return failure(json, error.code, error.error.message()),
    };
    let fixture = match fixtures::prepare(
        &options,
        &case.fixture,
        extension
            .as_ref()
            .and_then(|extension| extension.fixture_setup.as_ref()),
        extension
            .as_ref()
            .map_or(&[], |extension| extension.artifacts.as_slice()),
    ) {
        Ok(fixture) => fixture,
        Err(error) => return failure(json, 64, error.message()),
    };
    host.prepare_execution(&options, &fixture, &runtime);
    let identity = match identity::prepare(
        &options,
        &case,
        &fixture,
        &host,
        extension.as_ref(),
        &runtime,
    ) {
        Ok(identity) => identity,
        Err(error) => return failure(json, error.code, error.error.message()),
    };
    eprintln!("sevro: effective settings {}", identity.resolved);
    let result = records::run(&options, &case, &fixture, &identity, &host);
    drop(identity);
    let shutdown = host.shutdown();
    match result.and_then(|result| shutdown.map(|adapter_exit| (result, adapter_exit))) {
        Ok((completion, adapter_exit)) => {
            if let Some(message) = completion.result["diagnostic"]["message"].as_str() {
                eprintln!("sevro: {message}");
            }
            display(&completion.result, json, Some(&completion));
            if completion.exit_code == 0 {
                adapter_exit.map_or(0, |exit| exit.code)
            } else {
                completion.exit_code
            }
        }
        Err(error) => failure(json, 70, error.message()),
    }
}

fn display(result: &Value, json: bool, completion: Option<&records::Completion>) {
    if json {
        println!("{result}");
    } else {
        println!(
            "execution={} grading={} task={}",
            result["execution"]["status"].as_str().unwrap_or("not_run"),
            result["grading"]["status"]
                .as_str()
                .unwrap_or("not_requested"),
            result["task"]["verdict"].as_str().unwrap_or("not_assessed")
        );
        for selected in result["cases"].as_array().into_iter().flatten() {
            for trial in selected["trials"].as_array().into_iter().flatten() {
                println!(
                    "trial case={} trial={} execution={} grading={} task={}",
                    console_line(&selected["caseId"]),
                    trial["trial"],
                    trial["execution"]["status"].as_str().unwrap_or("not_run"),
                    trial["grading"]["status"]
                        .as_str()
                        .unwrap_or("not_requested"),
                    trial["task"]["verdict"].as_str().unwrap_or("not_assessed")
                );
                display_failed_checks(trial);
            }
        }
        if let Some(completion) = completion
            && let Some(result_file) = &completion.result_file
        {
            display_measurements(result, &completion.evidence);
            println!("result={}", result_file.display());
        }
        if let Some(path) = result["evidencePath"].as_str() {
            println!("evidence={path}");
        }
    }
}

fn display_failed_checks(trial: &Value) {
    for check in trial["checks"].as_array().into_iter().flatten() {
        if check["status"] != "passed" {
            println!(
                "  check={} status={} reason={}",
                console_line(&check["id"]),
                console_line(&check["status"]),
                console_line(&check["detail"])
            );
        }
    }
}

fn console_line(value: &Value) -> String {
    let safe: String = value
        .as_str()
        .unwrap_or("unknown")
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    String::from_utf16_lossy(&safe.encode_utf16().take(4096).collect::<Vec<_>>())
}

fn display_measurements(result: &Value, evidence: &Value) {
    for selected in result["cases"].as_array().into_iter().flatten() {
        let trials: Vec<_> = evidence["trials"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|trial| trial["caseId"] == selected["caseId"])
            .collect();
        let sum = |field: &str, usage: bool| -> Option<f64> {
            if trials.is_empty()
                || (usage
                    && trials
                        .iter()
                        .any(|trial| trial["usage"]["complete"] != true))
            {
                return None;
            }
            trials
                .iter()
                .map(|trial| {
                    if usage {
                        trial["usage"][field].as_f64()
                    } else {
                        trial[field].as_f64()
                    }
                })
                .sum()
        };
        let duration = sum("candidateDurationMs", false).map_or_else(
            || "unknown".into(),
            |value| format!("{}ms", fixed(value, 2)),
        );
        let input =
            sum("inputTokens", true).map_or_else(|| "unknown".into(), |value| value.to_string());
        let output =
            sum("outputTokens", true).map_or_else(|| "unknown".into(), |value| value.to_string());
        let cost = sum("costUsd", true)
            .map_or_else(|| "unknown".into(), |value| format!("${}", fixed(value, 4)));
        println!(
            "case={} candidate duration={duration} candidate tokens={input}/{output} cost={cost}",
            console_line(&selected["caseId"])
        );
    }
}

fn failure(json: bool, code: i32, message: &str) -> i32 {
    let message: String = message.chars().take(4096).collect();
    eprintln!("sevro: {message}");
    display(
        &json!({
            "format":"sevro.cli-result.v1", "runId":null,
            "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"}, "exitCode":code, "evidencePath":null,
            "cases":[], "diagnostic":{
                "code":if code == 64 { "sevro.invocation.invalid" } else { "sevro.runner.error" },
                "message":message
            }
        }),
        json,
        None,
    );
    if code == 70 {
        eprintln!(
            "Check the reported path and ensure --results-root and --run-state-root are writable directories, then retry."
        );
    } else {
        eprintln!(
            "Correct the named option or input and retry. Run sevro run --help for supported options."
        );
    }
    code
}
