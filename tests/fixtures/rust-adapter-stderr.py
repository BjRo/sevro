"""Observe a real CLI's caller-owned stderr while its adapter import is paused."""

import fcntl
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


def read_stderr(fd):
    chunks = []
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.05)[0]:
            continue
        chunk = os.read(fd, 65536)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        if sum(map(len, chunks)) > 65536:
            raise RuntimeError("adapter diagnostic fixture exceeded 64 KiB")
    raise RuntimeError("adapter stderr remained open after the CLI exited")


binary, selected = sys.argv[1:]
root = Path(selected)
case = root / "case.json"
case.write_text(json.dumps({
    "id": "adapter-prompt-only",
    "prompt": "Return ready.",
    "fixture": {"files": {"README.md": "adapter fixture\n"}},
    "checks": [],
    "requiredEvidence": [],
}))
read_fd, write_fd = os.pipe()
before_flags = fcntl.fcntl(write_fd, fcntl.F_GETFL)
process = None
try:
    process = subprocess.Popen([
        binary, "run", "--json", "--case-file", str(case),
        "--adapter-module", str(root / "adapter.ts"),
        "--project-root", str(root), "--results-root", str(root / "results"),
        "--runner-build-digest", "a" * 64, "--project-digest", "b" * 64,
    ], stdout=subprocess.PIPE, stderr=write_fd, start_new_session=True)
    deadline = time.monotonic() + 6
    ready = root / "ready"
    while not ready.exists() and process.poll() is None:
        if time.monotonic() >= deadline:
            raise RuntimeError("adapter import did not reach its ready marker")
        time.sleep(0.01)
    during_flags = fcntl.fcntl(write_fd, fcntl.F_GETFL)
    (root / "release").write_text("continue")
    stdout, _ = process.communicate(timeout=10)
    descendant = root / "descendant"
    descendant_alive = False
    if descendant.exists():
        os.kill(int(descendant.read_text()), 0)
        descendant_alive = True
finally:
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if process.poll() is None:
            process.wait(timeout=5)
    os.close(write_fd)

try:
    stderr = read_stderr(read_fd)
finally:
    os.close(read_fd)
print(json.dumps({
    "beforeFlags": before_flags,
    "duringFlags": during_flags,
    "ready": ready.exists(),
    "descendantAliveAtExit": descendant_alive,
    "code": process.returncode,
    "stdout": stdout.decode("utf-8"),
    "stderr": stderr.decode("utf-8"),
}))
