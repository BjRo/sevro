fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    std::process::exit(sevro::run_cli(&args));
}
