"""Exercise the maintained two-profile collector with real compiler counters."""

import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import sys


HELPER = Path(__file__).with_name("coverage-profiles.py")
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("coverage_profiles", HELPER)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

CARGO = '''[package]
name = "sevro"
version = "0.0.0"
edition = "2024"
publish = false
[features]
native-bundle = []
[[test]]
name = "installed_bundle"
required-features = ["native-bundle"]
'''
MAIN = '''#[cfg(feature = "native-bundle")]
mod bundle;
#[cfg(not(feature = "native-bundle"))]
mod standalone;
fn main() {
    let value = std::env::args().nth(1).expect("a control argument");
    #[cfg(feature = "native-bundle")]
    let result = bundle::classify(value == "pass");
    #[cfg(not(feature = "native-bundle"))]
    let result = standalone::classify(value == "pass");
    println!("{result}");
}
'''
CLASSIFY = '''pub fn classify(pass: bool) -> &'static str {
    if pass {
        "PROFILE-pass"
    } else {
        "PROFILE-fail"
    }
}
'''
DEFAULT = '''use std::process::Command;
#[test]
fn default_positive_control() {
    let output = Command::new(env!("CARGO_BIN_EXE_sevro")).arg("pass").output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"standalone-pass\\n");
}
'''
BUNDLE = '''use std::process::Command;
#[test]
fn bundle_controls() {
    for (argument, expected) in [("pass", "bundle-pass\\n"), ("fail", "bundle-fail\\n")] {
        let output = Command::new(env!("CARGO_BIN_EXE_sevro")).arg(argument).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, expected.as_bytes());
    }
}
'''
FAILED_DEFAULT = '''use std::process::Command;
#[test]
fn failed_default_cohort_control() {
    for (argument, expected) in [("pass", "standalone-pass\\n"), ("fail", "standalone-fail\\n")] {
        let output = Command::new(env!("CARGO_BIN_EXE_sevro")).arg(argument).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, expected.as_bytes());
    }
    panic!("intentional failed cohort control");
}
'''


def inspect(coverage, name, complete, expected_lines, expected_branches):
    summary = coverage.report(name, complete=complete)
    errors = ["line-region-gate exited 1"] if expected_lines[0] < expected_lines[1] else []
    if coverage.branch and expected_branches[0] < expected_branches[1]:
        errors.append("Branch gate exited 5")
    if summary["errors"] != errors:
        raise AssertionError(f"{name}: unexpected gate result: {summary}")
    report = json.loads((coverage.output / name / "coverage.json").read_text())
    data = report["data"][0]
    totals = data["totals"]
    lines = totals["lines"]
    if (lines["covered"], lines["count"]) != expected_lines:
        raise AssertionError(f"{name}: unexpected compiler line counters: {lines}")
    if coverage.branch:
        branches = totals["branches"]
        if (branches["covered"], branches["count"]) != expected_branches:
            raise AssertionError(f"{name}: unexpected compiler branch counters: {branches}")
    files = {item["filename"] for item in data["files"]}
    required = ["standalone"] + (["bundle"] if complete else [])
    for source in required:
        if str(coverage.root / "src" / (source + ".rs")) not in files:
            raise AssertionError("Missing authored control source: " + source)
    return {"phase": name, "totals": totals, "summary": summary}


def refuses(coverage, expected):
    try:
        coverage.require_inputs()
    except ValueError as error:
        if str(error) != expected:
            raise AssertionError(f"Unexpected completeness refusal: {error}") from error
        return str(error)
    raise AssertionError("Incomplete compiler evidence was accepted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--toolchain")
    parser.add_argument("--branch", action="store_true")
    args = parser.parse_args()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    root = output / "fixture"
    (root / "src").mkdir(parents=True)
    (root / "tests").mkdir()
    for name, contents in {"Cargo.toml": CARGO, "src/main.rs": MAIN,
                           "src/standalone.rs": CLASSIFY.replace("PROFILE", "standalone"),
                           "src/bundle.rs": CLASSIFY.replace("PROFILE", "bundle"),
                           "tests/default.rs": DEFAULT, "tests/installed_bundle.rs": BUNDLE}.items():
        (root / name).write_text(contents)
    shutil.copy2(HELPER, output / HELPER.name)
    shutil.copy2(MODULE.GATE, output / MODULE.GATE.name)
    coverage = MODULE.Coverage(root, output / "evidence", output / "target", args.toolchain, args.branch)
    records = []
    refusals = []
    try:
        result = coverage.command("lockfile", coverage.cargo + ["generate-lockfile", "--offline"])
        if result.returncode:
            raise ValueError("Control lockfile generation failed")
        coverage.prepare()
        coverage.collect("default")
        records.append(inspect(coverage, "default-only", False, (9, 10), (1, 2)))
        refusals.append(refuses(coverage, "Missing or failed required test cohort: native-bundle"))
        coverage.collect("native-bundle")
        inputs = coverage.require_inputs()
        records.append(inspect(coverage, "combined-partial", True, (14, 15), (3, 4)))
        # This is an explicit control execution, not a product test retry. It
        # executes the previously unvisited default outcome using the real binary.
        flags = ["--branch"] if args.branch else []
        result = coverage.command("complete-default-control", coverage.cargo + [
            "llvm-cov", "run"] + flags + ["--locked", "--no-report", "--", "fail"], "default")
        if result.returncode:
            raise ValueError("Completing the real default control failed")
        records.append(inspect(coverage, "combined-complete", True, (15, 15), (4, 4)))
        for profile in MODULE.PROFILES:
            if coverage.cohorts[profile]["sha256"] != inputs[profile]["sha256"]:
                raise AssertionError("Feature rebuild changed a retained executable receipt")
        original = coverage.require_inputs()
        withheld = output / "withheld"
        withheld.mkdir()
        raw = sorted(coverage.target.glob("native-bundle-*.profraw"))
        try:
            for path in raw:
                path.rename(withheld / path.name)
            refusals.append(refuses(coverage, "Missing or empty required raw profile cohort: native-bundle"))
        finally:
            for path in withheld.iterdir():
                path.rename(coverage.target / path.name)
        saved = Path(coverage.cohorts["native-bundle"]["executable"])
        moved = withheld / "sevro"
        saved.rename(moved)
        try:
            refusals.append(refuses(coverage, "Missing or changed required executable mapping: native-bundle"))
        finally:
            moved.rename(saved)
        if coverage.require_inputs() != original:
            raise AssertionError("Restored control inputs differ from their receipt")
        coverage.archive_inputs()
        # Exercise the public collector CLI too: even 100% counters cannot
        # excuse a real failed default test, and the bundle suite must still run.
        failed_root = output / "failed-fixture"
        shutil.copytree(root, failed_root)
        (failed_root / "tests/default.rs").write_text(FAILED_DEFAULT)
        argv = [sys.executable, str(HELPER), "--output-dir", str(output / "failed-evidence"),
                "--target-dir", str(output / "failed-target")]
        if args.toolchain:
            argv += ["--toolchain", args.toolchain]
        if args.branch:
            argv += ["--branch"]
        original_root = coverage.root
        coverage.root = failed_root
        try:
            failed = coverage.command("failed-cohort-public-cli", argv)
        finally:
            coverage.root = original_root
        evidence = output / "failed-evidence"
        statuses = {item["label"]: item["exitCode"] for item in
                    json.loads((evidence / "commands.json").read_text())}
        summary = json.loads((evidence / "combined/summary.json").read_text())
        if (failed.returncode != 1 or statuses["default-tests"] != 101
                or statuses["native-bundle-tests"] != 0 or statuses["combined-line-region-gate"] != 0
                or summary["errors"] != ["Missing or failed required test cohort: default"]):
            raise AssertionError("Public collector failed to retain and reject a failed test cohort")
        if args.branch and statuses["combined-branch-gate"] != 0:
            raise AssertionError("Failed-test control did not reach complete branch coverage")
        if not json.loads((evidence / "retained-inputs.json").read_text()):
            raise AssertionError("Failed-test control did not retain its compiler inputs")
        MODULE.write_json(output / "summary.json", {"success": True, "reports": records,
                          "missingInputRefusals": refusals,
                          "failedTestWithCompleteCountersRefused": True,
                          "purpose": "Real compiler tooling controls; not Sevro product coverage"})
    except (OSError, ValueError, AssertionError, KeyError) as error:
        MODULE.write_json(output / "summary.json", {"success": False, "error": str(error),
                          "reports": records, "missingInputRefusals": refusals})
        print(str(error), file=sys.stderr)
        return 1
    print("Two-profile compiler controls passed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
