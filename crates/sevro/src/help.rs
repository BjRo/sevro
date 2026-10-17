pub fn display(args: &[String]) -> bool {
    let request = args.join(" ");
    if matches!(request.as_str(), "--version" | "-v") {
        println!("sevro {}", env!("CARGO_PKG_VERSION"));
        return true;
    }
    let help = match request.as_str() {
        "" | "--help" | "-h" | "help" => include_str!("help/top-level.txt"),
        "run --help" | "run -h" | "help run" => include_str!("help/run.txt"),
        "report --help" | "report -h" | "help report" => include_str!("help/report.txt"),
        "init --help" | "init -h" | "help init" => include_str!("help/init.txt"),
        "demo --help" | "demo -h" | "help demo" => include_str!("help/demo.txt"),
        _ => return false,
    };
    print!("{help}");
    true
}
