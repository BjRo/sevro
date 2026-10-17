use crate::formatting::fixed;
use serde_json::Value;

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("unknown")
}

fn cell(value: &Value) -> String {
    text(value).replace('|', "\\|").replace(['\r', '\n'], " ")
}

fn measurement(value: &Value, digits: usize) -> String {
    value
        .as_f64()
        .map_or_else(|| "unknown".into(), |number| fixed(number, digits))
}

fn duration(value: &Value) -> String {
    value.as_f64().map_or_else(
        || "unknown".into(),
        |number| format!("{}s", fixed(number / 1000.0, 2)),
    )
}

fn rate(value: &Value) -> String {
    value.as_f64().map_or_else(
        || "unknown".into(),
        |number| format!("{}%", fixed(number * 100.0, 0)),
    )
}

fn cost(value: &Value) -> String {
    value.as_f64().map_or_else(
        || "unknown".into(),
        |number| format!("${}", fixed(number, 4)),
    )
}

fn rows(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

pub(super) fn markdown(report: &Value) -> String {
    let summary = &report["summary"];
    let mut lines = vec![
        "# Sevro evaluation report".into(),
        "".into(),
        "Task verdict, execution, and grading are separate. Unknown measurements are not zero. Rows do not claim matched comparisons.".into(),
        "".into(),
        format!("Cases: {}; passed: {}; failed: {}; not assessed: {}.", summary["cases"], summary["passed"], summary["failed"], summary["notAssessed"]),
        "".into(), "## Input runs".into(), "".into(),
        "| Result file | Exit | Execution | Grading | Task | Cases |".into(),
        "| --- | ---: | --- | --- | --- | ---: |".into(),
    ];
    for input in rows(&report["inputs"]) {
        lines.push(format!(
            "| {} | {} | {} | {} | {} | {} |",
            cell(&input["resultFile"]),
            input["exitCode"],
            text(&input["execution"]),
            text(&input["grading"]),
            text(&input["task"]),
            input["caseCount"]
        ));
    }
    lines.extend(["", "## Case outcomes", "", "| Case | Task | Execution | Grading | Pass rate | Candidate time | Candidate tokens | Candidate cost | Condition | Candidate route |", "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |"].map(str::to_owned));
    for row in rows(&report["rows"]) {
        lines.push(case_line(row));
    }
    lines.extend(["", "## Retained evidence", ""].map(str::to_owned));
    for row in rows(&report["rows"]) {
        lines.push(format!(
            "- {}: {}",
            cell(&row["caseId"]),
            row["evidencePath"].as_str().unwrap_or("unavailable")
        ));
    }
    if rows(&report["rows"])
        .iter()
        .any(|row| !rows(&row["domainOutcomes"]).is_empty())
    {
        lines.extend(
            [
                "",
                "## Domain outcomes",
                "",
                "Domain outcomes are independent of the task verdict.",
                "",
                "| Case | Trial | Outcome | Status |",
                "| --- | ---: | --- | --- |",
            ]
            .map(str::to_owned),
        );
        for row in rows(&report["rows"]) {
            for outcome in rows(&row["domainOutcomes"]) {
                lines.push(format!(
                    "| {} | {} | {} | {} |",
                    cell(&row["caseId"]),
                    outcome["trial"],
                    cell(&outcome["id"]),
                    text(&outcome["status"])
                ));
            }
        }
    }
    lines.extend(
        [
            "",
            "## Routes",
            "",
            "| Case | Role | Host | Model | Effort |",
            "| --- | --- | --- | --- | --- |",
        ]
        .map(str::to_owned),
    );
    for row in rows(&report["rows"]) {
        for route in rows(&row["routes"]) {
            lines.push(format!(
                "| {} | {} | {} | {} | {} |",
                cell(&row["caseId"]),
                text(&route["role"]),
                cell(&route["host"]),
                cell(&route["model"]),
                cell(&route["effort"])
            ));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn case_line(row: &Value) -> String {
    // report_row requires one candidate route before constructing any rendered row.
    let route = &row["candidateRoute"];
    let route_text = format!(
        "{}/{}@{}",
        cell(&route["host"]),
        cell(&route["model"]),
        cell(&route["effort"])
    );
    format!(
        "| {} | {} | {} | {} | {} | {} | {} / {} | {} | {} / {} | {} |",
        cell(&row["caseId"]),
        text(&row["task"]),
        text(&row["execution"]),
        text(&row["grading"]),
        rate(&row["taskPassRate"]),
        duration(&row["candidateDurationMs"]),
        measurement(&row["inputTokens"], 0),
        measurement(&row["outputTokens"], 0),
        cost(&row["costUsd"]),
        text(&row["requestedCondition"]),
        text(&row["actualCondition"]),
        route_text
    )
}
