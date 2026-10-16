mod adapters;
mod cancellation;
mod demo;
mod extension;
mod failure;
mod formatting;
mod help;
mod host;
mod init;
mod native;
mod report;
mod run;

pub fn run_cli(args: &[String]) -> i32 {
    if help::display(args) {
        return 0;
    }
    match args.first().map(String::as_str) {
        Some("demo") => demo::command(&args[1..]),
        Some("init") => init::command(&args[1..]),
        Some("report") => report::command(&args[1..]),
        Some("run") => run::command(&args[1..]),
        _ => failure::invalid_command(args),
    }
}
