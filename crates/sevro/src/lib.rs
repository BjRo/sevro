mod failure;
mod help;
mod init;
mod report;

pub fn run_cli(args: &[String]) -> i32 {
    if help::display(args) {
        return 0;
    }
    match args.first().map(String::as_str) {
        Some("init") => init::command(&args[1..]),
        Some("report") => report::command(&args[1..]),
        _ => failure::invalid_command(args),
    }
}
