use crate::host::HostResult;
use serde_json::{Map, Value};

pub(super) fn summarize(bytes: &[u8], exited_successfully: bool) -> HostResult {
    let mut results = Vec::new();
    let mut malformed = false;
    for line in String::from_utf8_lossy(bytes)
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(event)) if valid_event(&event) => {
                if event.get("type").and_then(Value::as_str) == Some("result") {
                    results.push(event);
                }
            }
            _ => malformed = true,
        }
    }
    let complete = !malformed
        && exited_successfully
        && !results.is_empty()
        && results.iter().all(|event| {
            event.get("subtype").and_then(Value::as_str) == Some("success")
                && event.get("is_error").and_then(Value::as_bool) == Some(false)
        });
    let measured = (!malformed && !results.is_empty())
        .then(|| {
            results
                .iter()
                .try_fold((0.0, 0.0), |(input, output), event| {
                    let usage = event.get("usage")?.as_object()?;
                    let tokens = nonnegative(usage.get("input_tokens")?)?
                        + optional_tokens(usage, "cache_creation_input_tokens")?
                        + optional_tokens(usage, "cache_read_input_tokens")?;
                    Some((
                        input + tokens,
                        output + nonnegative(usage.get("output_tokens")?)?,
                    ))
                })
        })
        .flatten();
    let cost = (!malformed && !results.is_empty())
        .then(|| {
            results.iter().try_fold(0.0, |total, event| {
                Some(total + nonnegative(event.get("total_cost_usd")?)?)
            })
        })
        .flatten();
    HostResult {
        final_message: results
            .last()
            .and_then(|event| event.get("result"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        complete,
        input_tokens: measured.map(|usage| usage.0),
        output_tokens: measured.map(|usage| usage.1),
        cost_usd: cost,
        usage_complete: Some(measured.is_some()),
        ..HostResult::default()
    }
}

fn valid_event(event: &Map<String, Value>) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("result") => {
            event
                .get("subtype")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
                && event.get("is_error").is_some_and(Value::is_boolean)
                && event.get("result").is_some_and(Value::is_string)
        }
        Some("assistant") => event
            .get("message")
            .and_then(|value| value.get("content"))
            .and_then(Value::as_array)
            .is_some_and(|blocks| blocks.iter().all(valid_block)),
        Some(_) => true,
        None => false,
    }
}

fn valid_block(value: &Value) -> bool {
    let Some(block) = value.as_object() else {
        return false;
    };
    if block.get("type").and_then(Value::as_str) != Some("tool_use")
        || block.get("name").and_then(Value::as_str) != Some("Skill")
    {
        return true;
    }
    block
        .get("input")
        .and_then(|input| input.get("skill"))
        .and_then(Value::as_str)
        .and_then(|skill| skill.rsplit(':').next())
        .is_some_and(|skill| !skill.trim().is_empty())
}

fn optional_tokens(usage: &Map<String, Value>, name: &str) -> Option<f64> {
    match usage.get(name) {
        None | Some(Value::Null) => Some(0.0),
        Some(value) => nonnegative(value),
    }
}

fn nonnegative(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
}
