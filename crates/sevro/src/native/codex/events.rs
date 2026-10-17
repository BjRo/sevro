use serde_json::Value;

pub(super) struct Summary {
    pub thread_id: String,
    pub final_message: Option<String>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub usage_complete: bool,
}

pub(super) fn summarize(bytes: &[u8], successful: bool) -> Result<Summary, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "Codex event stream contains invalid UTF-8")?;
    let mut thread = None;
    let mut completed = false;
    let mut failed = false;
    let mut final_message = None;
    let mut usage = None;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let event: Value =
            serde_json::from_str(line).map_err(|_| "Codex event stream contains invalid JSONL")?;
        match event
            .get("type")
            .and_then(Value::as_str)
            .ok_or("Codex event stream contains an invalid event")?
        {
            "thread.started" => {
                if thread.is_some() {
                    return Err("Codex event stream has an invalid thread start".into());
                }
                thread = event
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(String::from);
                if thread.is_none() {
                    return Err("Codex event stream has an invalid thread start".into());
                }
            }
            "turn.completed" => {
                if thread.is_none() || completed || failed {
                    return Err("Codex event stream has an invalid turn completion".into());
                }
                completed = true;
                usage = token_usage(&event["usage"]);
            }
            "turn.failed" => failed = true,
            "item.completed" if !completed && event["item"]["type"] == "agent_message" => {
                final_message = event["item"]["text"].as_str().map(String::from);
            }
            _ => {}
        }
    }
    let thread_id = thread.ok_or("Codex turn did not complete")?;
    if !completed || failed || !successful {
        return Err("Codex turn did not complete".into());
    }
    Ok(Summary {
        thread_id,
        final_message,
        input_tokens: usage.map(|(input, _)| input),
        output_tokens: usage.map(|(_, output)| output),
        usage_complete: usage.is_some(),
    })
}

fn token_usage(value: &Value) -> Option<(f64, f64)> {
    Some((
        count(&value["input_tokens"])?,
        count(&value["output_tokens"])?,
    ))
}

fn count(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|count| (0.0..=9_007_199_254_740_991.0).contains(count) && count.fract() == 0.0)
}
