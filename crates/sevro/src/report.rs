use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;

mod options;
mod render;
mod validation;

type ReportResult<T> = Result<T, String>;

pub fn command(args: &[String]) -> i32 {
    match report(args) {
        Ok(value) => {
            if args.iter().any(|arg| arg == "--json") {
                println!("{value}");
            } else {
                print!("{}", render::markdown(&value));
            }
            0
        }
        Err(message) => {
            eprintln!("{message}");
            64
        }
    }
}

fn report(args: &[String]) -> ReportResult<Value> {
    let validators = validation::Validators::new()?;
    let paths = options::result_paths(args)?;
    let mut inputs = Vec::new();
    let mut rows = Vec::new();
    for path in paths {
        let result = read_json(&path)?;
        validators.result(&result)?;
        let evidence = retained_evidence(&result, &validators)?;
        let cases = array(&result["cases"])?;
        inputs.push(json!({
            "resultFile":path, "execution":result["execution"]["status"],
            "grading":result["grading"]["status"],"task":result["task"]["verdict"],
            "exitCode":result["exitCode"],"caseCount":cases.len()
        }));
        if let Some(evidence) = evidence {
            for selected in cases {
                rows.push(report_row(&path, &result, selected, &evidence)?);
            }
        }
    }
    let count = |verdict: &str| rows.iter().filter(|row| row["task"] == verdict).count();
    let report = json!({
        "format":"sevro.report.v1", "inputs":inputs,
        "summary":{"cases":rows.len(),"passed":count("passed"),"failed":count("failed"),"notAssessed":count("not_assessed")},
        "rows":rows
    });
    validators.report(&report)?;
    Ok(report)
}

fn read_json(path: &PathBuf) -> ReportResult<Value> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn retained_evidence(
    result: &Value,
    validators: &validation::Validators,
) -> ReportResult<Option<Value>> {
    let path = result["evidencePath"]
        .as_str()
        .filter(|path| !path.is_empty());
    let Some(path) = path else {
        if !array(&result["cases"])?.is_empty() || result["exitCode"] == 0 {
            return Err("completed result has no retained evidence".into());
        }
        return Ok(None);
    };
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("evidence path must be absolute".into());
    }
    let evidence = read_json(&path)?;
    validators.evidence(&evidence)?;
    let retained_result =
        serde_jcs::to_vec(&evidence["result"]).map_err(|error| error.to_string())?;
    let selected_result = serde_jcs::to_vec(result).map_err(|error| error.to_string())?;
    if evidence["runId"] != result["runId"] || retained_result != selected_result {
        return Err("retained evidence differs from report result".into());
    }
    Ok(Some(evidence))
}

fn array(value: &Value) -> ReportResult<&Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| "expected an array in retained result".into())
}

fn sum_known(values: impl Iterator<Item = Option<f64>>) -> ReportResult<Option<f64>> {
    let Some(values) = values.collect::<Option<Vec<_>>>() else {
        return Ok(None);
    };
    if values.is_empty() {
        return Ok(None);
    }
    let total: f64 = values.iter().sum();
    if !total.is_finite() {
        return Err("invalid Sevro report".into());
    }
    Ok(Some(total))
}

fn pass_rate(trials: &[Value]) -> Option<f64> {
    if trials.is_empty()
        || trials.iter().any(|trial| {
            trial["execution"]["status"] != "completed"
                || trial["grading"]["status"] != "completed"
                || trial["task"]["verdict"] == "not_assessed"
        })
    {
        return None;
    }
    let passed = trials
        .iter()
        .filter(|trial| trial["task"]["verdict"] == "passed")
        .count();
    Some(passed as f64 / trials.len() as f64)
}

fn report_row(
    path: &PathBuf,
    result: &Value,
    selected: &Value,
    evidence: &Value,
) -> ReportResult<Value> {
    let trials = array(&selected["trials"])?;
    let retained: Vec<_> = array(&evidence["trials"])?
        .iter()
        .filter(|trial| trial["caseId"] == selected["caseId"])
        .collect();
    if retained.len() != trials.len()
        || trials.iter().any(|trial| {
            retained
                .iter()
                .filter(|item| item["trial"].as_f64() == trial["trial"].as_f64())
                .count()
                != 1
        })
    {
        return Err("retained trial evidence differs from report result".into());
    }
    let routes = array(&evidence["routes"])?;
    let candidates: Vec<_> = routes
        .iter()
        .filter(|route| route["role"] == "candidate")
        .collect();
    if candidates.len() != 1 {
        return Err("retained candidate route is ambiguous".into());
    }
    let route = candidates[0];
    let complete_usage = !retained.is_empty()
        && retained
            .iter()
            .all(|trial| trial["usage"]["complete"] == true);
    let usage = |field: &str| {
        if complete_usage {
            sum_known(retained.iter().map(|trial| trial["usage"][field].as_f64()))
        } else {
            Ok(None)
        }
    };
    Ok(json!({
        "resultFile":path,"evidencePath":result["evidencePath"],"runId":result["runId"],"caseId":selected["caseId"],
        "execution":selected["execution"]["status"],"grading":selected["grading"]["status"],"task":selected["task"]["verdict"],"exitCode":result["exitCode"],
        "trialCount":trials.len(),"taskPassRate":pass_rate(trials),
        "candidateDurationMs":sum_known(retained.iter().map(|trial| trial["candidateDurationMs"].as_f64()))?,
        "inputTokens":usage("inputTokens")?,"outputTokens":usage("outputTokens")?,"costUsd":usage("costUsd")?,
        "runnerBuildDigest":evidence["runner"]["buildDigest"],"evaluationDigest":evidence["evaluationIdentity"]["digest"],
        "requestedCondition":evidence["condition"]["requested"],"actualCondition":evidence["condition"]["actual"],
        "candidateRoute":{"host":route["host"],"model":route["model"],"effort":route["effort"]},
        "routes":routes,"domainOutcomes":domain_outcomes(trials)
    }))
}

fn domain_outcomes(trials: &[Value]) -> Vec<Value> {
    trials
        .iter()
        .flat_map(|trial| {
            trial["domainOutcomes"].as_array().into_iter().flatten().map(|outcome| {
            json!({"trial":trial["trial"], "id":outcome["id"], "status":outcome["status"]})
        })
        })
        .collect()
}
