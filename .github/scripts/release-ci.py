"""Reuse a completed main quality gate for changes limited to release metadata."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen


RELEASE_FILES = {
    "package.json",
    "docs/installing.md",
    "docs/releases.md",
    "docs/typescript-quality.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    ".github/workflows/verify.yml",
    ".github/scripts/release-ci.py",
}
VERSION = re.compile(
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?"
)


def git(*args):
    return subprocess.check_output(["git", *args])


def manifest(commit):
    value = json.loads(git("show", f"{commit}:package.json"))
    if not isinstance(value, dict):
        raise ValueError("package.json must be an object")
    return value


def release_identity(value):
    version = value.get("version", "")
    return (
        isinstance(version, str)
        and VERSION.fullmatch(version) is not None
        and re.search(r"(?:^|[.-])dev(?:[.-]|$)", version, re.I) is None
        and value.get("publishConfig", {}).get("tag") in {"latest", "next"}
    )


def package_inputs(value):
    value = dict(value)
    value.pop("version", None)
    publish = dict(value.get("publishConfig", {}))
    publish.pop("tag", None)
    value["publishConfig"] = publish
    return value


def unchanged_inputs(source, candidate):
    changed = git("diff", "--name-only", "--no-renames", "-z", source, candidate)
    paths = {path.decode() for path in changed.split(b"\0") if path}
    return paths <= RELEASE_FILES and package_inputs(manifest(source)) == package_inputs(
        manifest(candidate)
    )


def api(path):
    request = Request(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
        },
    )
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def completed_full_gate(run_id):
    jobs = api(f"actions/runs/{run_id}/jobs?per_page=100")["jobs"]
    return any(
        job["conclusion"] == "success"
        and any(
            step["name"] == "Canonical TypeScript quality gate"
            and step["conclusion"] == "success"
            for step in job.get("steps", [])
        )
        for job in jobs
    )


def verified_source(candidate):
    runs = api(
        "actions/workflows/verify.yml/runs"
        "?branch=main&event=push&status=success&per_page=100"
    )["workflow_runs"]
    for run in runs:
        source = run["head_sha"]
        if run["head_branch"] != "main" or not re.fullmatch(r"[0-9a-f]{40}", source):
            continue
        ancestor = subprocess.run(
            ["git", "merge-base", "--is-ancestor", source, candidate], check=False
        )
        if ancestor.returncode == 1:
            continue
        if ancestor.returncode != 0:
            raise ValueError("could not verify the tested source ancestry")
        if unchanged_inputs(source, candidate) and completed_full_gate(run["id"]):
            return run
    raise ValueError("release requires a successful main quality gate for unchanged inputs")


def output(name, value):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf8") as destination:
        destination.write(f"{name}={value}\n")


def plan():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    kind = os.environ["GITHUB_EVENT_NAME"]
    if kind == "pull_request":
        source = event["pull_request"]["base"]["sha"]
        candidate = os.environ["GITHUB_SHA"]
    elif kind == "push":
        source, candidate = event["before"], event["after"]
    else:
        output("reuse", "false")
        return
    if not all(re.fullmatch(r"[0-9a-f]{40}", sha) and sha != "0" * 40 for sha in [source, candidate]):
        output("reuse", "false")
        return
    before, after = manifest(source), manifest(candidate)
    if before.get("version") == after.get("version") or not unchanged_inputs(source, candidate):
        output("reuse", "false")
        return
    if not release_identity(after):
        raise ValueError("release metadata must select a release version and latest or next")
    run = verified_source(candidate)
    url = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{run['id']}"
    record = {
        "format": "sevro.release-ci.v1",
        "candidate": candidate,
        "version": after["version"],
        "testedSource": run["head_sha"],
        "qualityRunId": run["id"],
        "qualityRunUrl": url,
        "testsRerun": False,
    }
    Path(".quality").mkdir(exist_ok=True)
    Path(".quality/release-ci.json").write_text(json.dumps(record, indent=2) + "\n")
    output("reuse", "true")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf8") as summary:
        summary.write(
            f"Release {after['version']} reuses [completed source CI]({url}) "
            f"at `{run['head_sha']}`. Code, dependencies and test inputs are unchanged. "
            "Release metadata receives static checks; tests and coverage are not rerun.\n"
        )


if __name__ == "__main__":
    try:
        plan()
    except Exception as error:
        print(f"Release CI decision failed: {error}", file=sys.stderr)
        sys.exit(1)
