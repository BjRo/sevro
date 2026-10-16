"""Collect both required Rust profiles without losing overwritten executable mappings."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys


PROFILES = ("default", "native-bundle")
GATE = Path(__file__).with_name("branch-coverage.jq")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def object_sets(stderr):
    result = []
    for line in stderr.decode().splitlines():
        if "Running" not in line or "-object" not in line:
            continue
        words = shlex.split(line.split("Running", 1)[1].strip())
        objects = sorted({str(Path(words[index + 1]).resolve())
                          for index, word in enumerate(words[:-1]) if word == "-object"})
        if objects:
            result.append(objects)
    if not result:
        raise ValueError("Verbose report did not expose executable object mappings")
    return result


class Coverage:
    """One fresh compiler/platform/candidate cohort; also used by real compiler controls."""

    def __init__(self, root, output, target, toolchain=None, branch=False):
        self.root = root.resolve()
        self.output = output.resolve()
        self.target = target.resolve()
        # Never reuse manually retained objects or raw profiles from an earlier run.
        self.output.mkdir(parents=True, exist_ok=False)
        self.target.mkdir(parents=True, exist_ok=False)
        self.logs = self.output / "logs"
        self.logs.mkdir()
        self.cargo = ["cargo"] + (["+" + toolchain] if toolchain else [])
        self.branch = branch
        self.env = dict(os.environ)
        for key in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER",
                    "RUSTC_WORKSPACE_WRAPPER", "LLVM_PROFILE_FILE", "LLVM_PROFILE_FILE_NAME",
                    "LLVM_COV_FLAGS", "LLVM_PROFDATA_FLAGS", "CARGO_LLVM_COV_BUILD_DIR"):
            self.env.pop(key, None)
        self.env.update(CARGO_LLVM_COV_TARGET_DIR=str(self.target), CARGO_TERM_COLOR="never")
        self.commands = []
        self.cohorts = {}
        self.final_objects = []

    def command(self, label, argv, profile=None):
        env = dict(self.env)
        if profile:
            env["LLVM_PROFILE_FILE_NAME"] = profile + "-%p-%m.profraw"
        result = subprocess.run(argv, cwd=self.root, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        (self.logs / (label + ".stdout")).write_bytes(result.stdout)
        (self.logs / (label + ".stderr")).write_bytes(result.stderr)
        self.commands.append({"label": label, "argv": argv, "cwd": str(self.root),
                              "exitCode": result.returncode,
                              "environment": {key: env.get(key) for key in
                                              ("CARGO_LLVM_COV_TARGET_DIR", "LLVM_PROFILE_FILE_NAME")}})
        write_json(self.output / "commands.json", self.commands)
        print(f"{label}: exit {result.returncode}", flush=True)
        if result.returncode:
            print(f"See {self.logs / label}.stdout and .stderr", file=sys.stderr, flush=True)
        return result

    def prepare(self):
        rustc = ["rustc"] + self.cargo[1:]
        for label, argv in (("rustc", rustc + ["-vV"]),
                            ("cargo", self.cargo + ["--version"]),
                            ("llvm-cov", self.cargo + ["llvm-cov", "--version"]),
                            ("clean", self.cargo + ["llvm-cov", "clean", "--workspace"])):
            if self.command(label, argv).returncode:
                raise ValueError("Coverage prerequisite failed: " + label)

    def collect(self, profile):
        if profile not in PROFILES or profile in self.cohorts:
            raise ValueError("Unexpected or repeated coverage cohort: " + profile)
        flags = ["--workspace", "--all-targets"] if profile == "default" else [
            "-p", "sevro", "--features", "native-bundle", "--test", "installed_bundle"]
        argv = self.cargo + ["llvm-cov"] + (["--branch"] if self.branch else []) + flags
        result = self.command(profile + "-tests", argv + ["--locked", "--no-fail-fast", "--no-report"], profile)
        record = {"exitCode": result.returncode}
        saved = self.target / "debug/retained-coverage" / profile / "sevro"
        saved.parent.mkdir(parents=True)
        executable = self.target / "debug/sevro"
        if executable.is_file():
            # A waited child closes writable descriptors before later child processes start.
            copied = self.command(profile + "-retain", ["/bin/cp", str(executable), str(saved)])
            if copied.returncode == 0:
                record.update(executable=str(saved), sha256=sha256(saved))
        self.cohorts[profile] = record
        write_json(self.output / "cohorts.json", self.cohorts)

    def require_inputs(self):
        inputs = {}
        for profile in PROFILES:
            record = self.cohorts.get(profile)
            if record is None or record["exitCode"] != 0:
                raise ValueError("Missing or failed required test cohort: " + profile)
            raw = sorted(self.target.glob(profile + "-*.profraw"))
            if not raw or any(path.stat().st_size == 0 for path in raw):
                raise ValueError("Missing or empty required raw profile cohort: " + profile)
            saved = Path(record.get("executable", ""))
            if not saved.is_file() or sha256(saved) != record.get("sha256"):
                raise ValueError("Missing or changed required executable mapping: " + profile)
            inputs[profile] = {**record, "profiles": [
                {"path": str(path), "sha256": sha256(path)} for path in raw]}
        return inputs

    def report(self, name, complete=True):
        folder = self.output / name
        folder.mkdir()
        errors = []
        if complete:
            try:
                write_json(folder / "inputs.json", self.require_inputs())
            except ValueError as error:
                errors.append(str(error))
        base = self.cargo + ["llvm-cov", "report", "--failure-mode", "any",
                             "--ignore-filename-regex", "(^|/)tests/", "-v"]
        commands = [
            ("json", ["--json", "--output-path", str(folder / "coverage.json")]),
            ("lcov", ["--lcov", "--output-path", str(folder / "lcov.info")]),
            ("html", ["--html", "--output-dir", str(folder / "html")]),
            ("line-region-gate", ["--fail-under-lines", "95", "--fail-under-regions", "95"]),
        ]
        mappings = None
        for label, args in commands:
            result = self.command(name + "-" + label, base + args)
            if result.returncode:
                errors.append(label + " exited " + str(result.returncode))
            try:
                sets = object_sets(result.stderr)
                if mappings is None:
                    mappings = sets[0]
                if any(objects != mappings for objects in sets):
                    raise ValueError("Export and enforcement used different object mappings")
            except ValueError as error:
                errors.append(str(error))
        if mappings is not None:
            if complete:
                for profile in PROFILES:
                    saved = str(self.target / "debug/retained-coverage" / profile / "sevro")
                    if saved not in mappings:
                        errors.append("Required executable absent from report mappings: " + profile)
            self.final_objects = [
                {"path": path, "sha256": sha256(Path(path))} for path in mappings]
            write_json(folder / "objects.json", self.final_objects)
        report = folder / "coverage.json"
        if report.is_file():
            value = json.loads(report.read_text())
            files = sorted(item["filename"] for item in value["data"][0]["files"])
            authored = sorted(str(path.resolve()) for path in self.root.glob("crates/*/src/**/*.rs"))
            write_json(folder / "inventory.json", {"authored": authored, "reported": files,
                       "unmapped": sorted(set(authored) - set(files))})
            bundle = self.root / "crates/sevro/src/run/provenance/bundle.rs"
            if complete and bundle.is_file() and str(bundle) not in files:
                errors.append("Authored native-bundle source absent from compiler inventory")
        else:
            errors.append("Compiler JSON report is missing")
        if self.branch:
            result = self.command(name + "-branch-gate", ["jq", "--exit-status", "--slurp",
                                  "--from-file", str(GATE), str(report)])
            if result.returncode:
                errors.append("Branch gate exited " + str(result.returncode))
        summary = {"completeRequired": complete, "accepted": not errors, "errors": errors}
        write_json(folder / "summary.json", summary)
        return summary

    def archive_inputs(self):
        """Retain raw counters and every report object, without uploading the build cache."""
        archive = self.output / "retained-inputs"
        archive.mkdir()
        objects = {}
        for record in self.cohorts.values():
            if "executable" in record and Path(record["executable"]).is_file():
                objects[record["executable"]] = record["sha256"]
        for item in self.final_objects:
            objects[item["path"]] = item["sha256"]
        files = sorted(self.target.glob("*.profraw")) + sorted(self.target.glob("*.profdata"))
        files += [Path(path) for path in objects]
        manifest = []
        for path in files:
            digest = sha256(path)
            if str(path) in objects and digest != objects[str(path)]:
                raise ValueError("Executable mapping changed after reporting: " + str(path))
            destination = archive / digest
            if not destination.exists():
                shutil.copy2(path, destination)
            manifest.append({"originalPath": str(path), "sha256": digest,
                             "retainedPath": str(destination.relative_to(self.output))})
        write_json(self.output / "retained-inputs.json", manifest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--target-dir", type=Path, required=True)
    parser.add_argument("--toolchain")
    parser.add_argument("--branch", action="store_true")
    args = parser.parse_args()
    coverage = Coverage(Path.cwd(), args.output_dir, args.target_dir, args.toolchain, args.branch)
    errors = []
    try:
        coverage.prepare()
        # A failed default cohort does not prevent collecting diagnostic bundle evidence.
        for profile in PROFILES:
            coverage.collect(profile)
        summary = coverage.report("combined")
        errors.extend(summary["errors"])
    except (OSError, ValueError, KeyError) as error:
        errors.append(str(error))
    try:
        coverage.archive_inputs()
    except (OSError, ValueError, KeyError) as error:
        errors.append(str(error))
    if errors:
        write_json(coverage.output / "failure.json", {"errors": errors})
        print("; ".join(errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
