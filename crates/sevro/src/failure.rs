pub fn invalid_command(args: &[String]) -> i32 {
    let message = "expected the run command";
    eprintln!("sevro: {message}");
    if json_requested(args) {
        println!(
            "{}",
            serde_json::json!({
                "format": "sevro.cli-result.v1",
                "runId": null,
                "execution": {"status": "not_run"},
                "grading": {"status": "not_requested"},
                "task": {"verdict": "not_assessed"},
                "exitCode": 64,
                "evidencePath": null,
                "cases": [],
                "diagnostic": {"code": "sevro.invocation.invalid", "message": message}
            })
        );
    } else {
        println!("execution=not_run grading=not_requested task=not_assessed");
    }
    eprintln!(
        "Correct the named option or input and retry. Run sevro run --help for examples and required options."
    );
    64
}

fn json_requested(args: &[String]) -> bool {
    args.iter()
        .rev()
        .find_map(|argument| match argument.as_str() {
            "--json" => Some(true),
            "--no-json" => Some(false),
            _ => None,
        })
        .unwrap_or(false)
}
