"""Check raw-counter rejection and real pinned-compiler branch controls."""

import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess


GATE = Path(__file__).with_name("branch-coverage.jq")
NIGHTLY = "nightly-2026-10-15"
THRESHOLD_SOURCE = """pub fn choose(flag: bool) -> u8 {
    let mut result = 1;
    if flag {
        result = 2;
    }
    result
}
"""
THRESHOLD_TESTS = """#[test]
fn negative() {
    assert_eq!(coverage_branch_probe::choose(true), 2);
}
#[test]
fn positive() {
    assert_eq!(coverage_branch_probe::choose(true), 2);
    assert_eq!(coverage_branch_probe::choose(false), 1);
}
"""
CONSTRUCTS = {
    "if_branch": ("pub fn choose(v: bool) -> u8 { if v { 1 } else { 2 } }", 2),
    "boolean_branch": (
        "pub fn choose(a: bool, b: bool, c: bool) -> bool { if a && b || c { true } else { false } }",
        6,
    ),
    "boolean_value": ("pub fn choose(a: bool, b: bool) -> bool { a && b }", 2),
    "if_let": ("pub fn choose(v: Option<u8>) -> u8 { if let Some(n) = v { n } else { 0 } }", 2),
    "let_else": ("pub fn choose(v: Option<u8>) -> u8 { let Some(n) = v else { return 0; }; n }", 2),
    "while_branch": ("pub fn choose(mut v: u8) -> u8 { while v > 0 { v -= 1; } v }", 2),
    "match_guard": ("pub fn choose(v: u8, flag: bool) -> u8 { match v { 0 if flag => 1, _ => 2 } }", 2),
    "match_branch": ("pub fn choose(v: u8) -> u8 { match v { 0 => 10, 1 | 2 => 20, _ => 30 } }", 0),
    "try_branch": ("pub fn choose(v: Result<u8, ()>) -> Result<u8, ()> { let n = v?; Ok(n + 1) }", 0),
    "await_branch": ("pub async fn choose() -> u8 { std::future::ready(1u8).await }", 0),
    "macro_branch": (
        "macro_rules! select { ($v:expr) => { if $v { 1 } else { 2 } }; }\n"
        "pub fn choose(v: bool) -> u8 { select!(v) }",
        2,
    ),
}
CONSTRUCT_TESTS = """use coverage_branch_probe::*;
use std::future::Future;
use std::task::{Context, Poll, Waker};
#[test]
fn all_paths() {
    assert_eq!(if_branch::choose(true), 1);
    assert_eq!(if_branch::choose(false), 2);
    for a in [false, true] {
        for b in [false, true] {
            assert_eq!(boolean_value::choose(a, b), a && b);
            for c in [false, true] {
                assert_eq!(boolean_branch::choose(a, b, c), a && b || c);
            }
        }
    }
    assert_eq!(if_let::choose(Some(2)), 2);
    assert_eq!(if_let::choose(None), 0);
    assert_eq!(let_else::choose(Some(2)), 2);
    assert_eq!(let_else::choose(None), 0);
    assert_eq!(while_branch::choose(0), 0);
    assert_eq!(while_branch::choose(2), 0);
    assert_eq!(match_guard::choose(0, true), 1);
    assert_eq!(match_guard::choose(0, false), 2);
    assert_eq!(match_guard::choose(1, true), 2);
    assert_eq!(match_branch::choose(0), 10);
    assert_eq!(match_branch::choose(1), 20);
    assert_eq!(match_branch::choose(2), 20);
    assert_eq!(match_branch::choose(3), 30);
    assert_eq!(try_branch::choose(Ok(1)), Ok(2));
    assert_eq!(try_branch::choose(Err(())), Err(()));
    assert_eq!(macro_branch::choose(true), 1);
    assert_eq!(macro_branch::choose(false), 2);
    let mut ready = std::pin::pin!(await_branch::choose());
    let mut context = Context::from_waker(Waker::noop());
    assert_eq!(ready.as_mut().poll(&mut context), Poll::Ready(1));
}
"""


def sample(covered=19, count=20, percent=100):
    return {
        "type": "llvm.coverage.json.export",
        "version": "3.1.0",
        "cargo_llvm_cov": {"version": "0.9.1"},
        "data": [{"totals": {"branches": {
            "count": count, "covered": covered,
            "notcovered": count - covered, "percent": percent,
        }}}],
    }


def raw_cases():
    cases = [
        ("exact-95", sample(), True),
        ("below-95", sample(18), False),
        ("unrounded-below-95", sample(18999, 20000), False),
        ("ignore-display-percent", sample(percent=0), True),
        ("zero-denominator", sample(0, 0), False),
        ("negative-count", sample(0, -1), False),
        ("fractional-count", sample(1, 1.5), False),
        ("covered-exceeds-count", sample(21), False),
        ("unsafe-multiplication", sample(90071992547410, 90071992547410), False),
        ("largest-exact-counter", sample(90071992547409, 90071992547409), True),
        ("missing-data", {}, False),
    ]
    for key in ["count", "covered", "notcovered"]:
        missing = sample()
        del missing["data"][0]["totals"]["branches"][key]
        cases.append(("missing-" + key, missing, False))
        text = sample()
        text["data"][0]["totals"]["branches"][key] = "20"
        cases.append(("string-" + key, text, False))
    inconsistent = sample()
    inconsistent["data"][0]["totals"]["branches"]["notcovered"] = 0
    cases.append(("inconsistent-remainder", inconsistent, False))
    ambiguous = sample()
    ambiguous["data"].append(copy.deepcopy(ambiguous["data"][0]))
    cases.append(("ambiguous-datasets", ambiguous, False))
    for key in ["type", "version"]:
        changed = sample()
        changed[key] = "unexpected"
        cases.append(("unexpected-" + key, changed, False))
    wrong_tool = sample()
    wrong_tool["cargo_llvm_cov"]["version"] = "unexpected"
    cases.append(("unexpected-tool-version", wrong_tool, False))
    empty = sample()
    empty["data"] = []
    cases.append(("empty-datasets", empty, False))
    absent = sample()
    absent["data"][0]["totals"] = {}
    cases.append(("missing-branches", absent, False))
    return cases


def check_report(path, expected, checks):
    result = subprocess.run(
        ["jq", "--exit-status", "--slurp", "--from-file", str(GATE), str(path)],
        text=True, capture_output=True, check=False,
    )
    path.with_suffix(".gate.stdout").write_text(result.stdout)
    path.with_suffix(".gate.stderr").write_text(result.stderr)
    passed = result.returncode == 0
    if passed != expected:
        raise AssertionError(f"{path.name}: expected {expected}, exit {result.returncode}: {result.stderr}")
    if passed:
        summary = json.loads(result.stdout)
        if summary["metric"] != "LLVM supported branch outcomes" or summary["requiredPercent"] != 95:
            raise AssertionError(f"{path.name}: unexpected threshold summary")
    checks.append({"case": path.name, "accepted": passed, "exitCode": result.returncode})


def check_raw(output, checks):
    output.mkdir()
    for name, value, accepted in raw_cases():
        path = output / (name + ".json")
        path.write_text(json.dumps(value))
        check_report(path, accepted, checks)
    for name, text in [
        ("empty", ""),
        ("malformed", "{"),
        ("multiple-documents", json.dumps(sample(0, 1)) + "\n" + json.dumps(sample())),
    ]:
        path = output / (name + ".json")
        path.write_text(text)
        check_report(path, False, checks)


def command(argv, cwd, environment, log):
    result = subprocess.run(argv, cwd=cwd, env=environment, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    with log.open("a") as stream:
        stream.write("$ " + " ".join(argv) + "\n" + result.stdout)
    if result.returncode:
        raise RuntimeError(f"{argv[0]} exited {result.returncode}; see {log}\n{result.stdout}")
    return result.stdout


def fixture(path, library, tests):
    (path / "src").mkdir(parents=True)
    (path / "tests").mkdir()
    (path / "Cargo.toml").write_text(
        '[package]\nname = "coverage_branch_probe"\nversion = "0.0.0"\n'
        'edition = "2024"\npublish = false\n\n[workspace]\n'
    )
    (path / "src/lib.rs").write_text(library)
    (path / "tests/controls.rs").write_text(tests)


def measure(root, case, project, test_name):
    output = root / case
    output.mkdir()
    environment = dict(os.environ, CARGO_LLVM_COV_TARGET_DIR=str(output / "target"))
    log = output / "compiler.log"
    cargo = ["cargo", "+" + NIGHTLY]
    command(cargo + ["generate-lockfile", "--offline"], project, environment, log)
    command(cargo + ["llvm-cov", "clean", "--workspace"], project, environment, log)
    report = output / "coverage.json"
    command(cargo + [
        "llvm-cov", "--branch", "--locked", "--test", "controls", "--json",
        "--ignore-filename-regex", "(^|/)tests/", "--output-path", str(report),
        "--", test_name, "--exact",
    ], project, environment, log)
    return report


def compiler_controls(root, checks):
    threshold = root / "threshold-fixture"
    fixture(threshold, THRESHOLD_SOURCE, THRESHOLD_TESTS)
    for name, expected in [("negative", (1, 2)), ("positive", (2, 2))]:
        report = measure(root, name, threshold, name)
        counts = json.loads(report.read_text())["data"][0]["totals"]["branches"]
        if (counts["covered"], counts["count"]) != expected:
            raise AssertionError(f"Compiler {name} control changed: {counts}")
        check_report(report, name == "positive", checks)
    project = root / "construct-fixture"
    fixture(project, "\n".join("pub mod " + name + ";" for name in CONSTRUCTS), CONSTRUCT_TESTS)
    for name, (source, _) in CONSTRUCTS.items():
        (project / "src" / (name + ".rs")).write_text(source + "\n")
    report = measure(root, "constructs", project, "all_paths")
    files = json.loads(report.read_text())["data"][0]["files"]
    observed = {Path(item["filename"]).stem: item["summary"]["branches"] for item in files}
    if set(observed) != set(CONSTRUCTS):
        raise AssertionError(f"Compiler control source inventory changed: {sorted(observed)}")
    for name, (_, count) in CONSTRUCTS.items():
        if (observed[name]["count"], observed[name]["covered"]) != (count, count):
            raise AssertionError(f"Compiler construct {name} changed: {observed[name]}")
    check_report(report, True, checks)
    return observed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--toolchain", choices=[NIGHTLY], default=NIGHTLY)
    options = parser.parse_args()
    root = options.output_dir.resolve()
    root.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(GATE, root / GATE.name)
    shutil.copyfile(__file__, root / Path(__file__).name)
    checks = []
    check_raw(root / "raw", checks)
    log = root / "tools.log"
    compiler = command(["rustc", "+" + NIGHTLY, "-vV"], root, os.environ, log)
    coverage = command(["cargo", "+" + NIGHTLY, "llvm-cov", "--version"], root, os.environ, log)
    constructs = compiler_controls(root, checks)
    summary = {"toolchain": NIGHTLY, "compiler": compiler, "coverage": coverage,
               "metric": "LLVM supported branch outcomes", "checks": checks,
               "constructs": constructs}
    (root / "controls.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Passed {len(checks)} branch gate controls; evidence: {root}")


if __name__ == "__main__":
    main()
