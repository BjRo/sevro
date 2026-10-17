#!/usr/bin/env python3
"""Bounded Linux-only Codex 0.160.1 policy observation; no model/auth/network calls.

Run after the ordinary CI native prerequisites, outside parallel test execution:
  python3 scripts/rust/diagnose-linux-temp-policy.py --output /absolute/evidence-directory

This records failures rather than repairing, retrying, or removing shared metadata.
All mutation by this script is confined to its own mkdtemp roots and output folder.
The upstream sandbox may itself create/remove /tmp metadata mount placeholders.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import shlex

LIMIT = 1024 * 1024
DEADLINE = 60
SHARED_TARGETS = tuple(Path('/tmp') / name for name in ('.git', '.codex', '.agents', '.aws'))


def bounded(path):
    with path.open('rb') as stream:
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise RuntimeError('diagnostic output exceeded one MiB')
    return data


def metadata(path):
    try:
        value = path.lstat()
    except FileNotFoundError:
        return {'exists': False}
    return {'exists': True, 'mode': stat.S_IFMT(value.st_mode),
            'device': value.st_dev, 'inode': value.st_ino}


def snapshot(states):
    registries = {}
    for state in states:
        for label in ('tmp', 'command-tmp'):
            root = state / label / f'codex-bwrap-synthetic-mount-targets-{os.geteuid()}'
            markers = []
            if root.exists():
                for target in sorted(root.iterdir())[:64]:
                    if target.is_dir() and not target.is_symlink():
                        markers.extend(str(path.relative_to(root)) for path in sorted(target.iterdir())[:16])
            registries[f'{state.name}/{label}'] = markers
    return {'shared_metadata': {str(path): metadata(path) for path in SHARED_TARGETS},
            'private_registry_marker_names': registries}


def private_file(path, content):
    path.write_text(content)
    path.chmod(0o600)


def profile(state, workspace, protected, binary, private_only):
    q = json.dumps
    lines = ['default_permissions = "replay"', 'approval_policy = "never"',
             'allow_login_shell = false', '[features]', 'hooks = false',
             '[shell_environment_policy]', 'inherit = "none"', 'ignore_default_excludes = false',
             '[shell_environment_policy.set]', 'PATH = "/usr/bin:/bin"',
             f'HOME = {q(str(state / "command-home"))}',
             f'TMPDIR = {q(str(state / "command-tmp"))}',
             f'TMPPREFIX = {q(str(state / "command-tmp") + "/")}',
             '[permissions.replay]', 'extends = ":workspace"',
             '[permissions.replay.filesystem]', '":root" = "deny"', '":minimal" = "read"']
    if private_only:
        # The sole experimental change: private launcher TMPDIR remains inherited.
        lines.append('\":slash_tmp\" = \"deny\"')
    lines.extend(f'{q(str(path))} = "deny"' for path in protected)
    lines.append(f'{q(str(binary.parent))} = "read"')
    lines.extend(f'{q(str(path))} = "write"' for path in
                 (state / 'command-home', state / 'command-tmp', workspace / '.git'))
    lines.extend(['[permissions.replay.filesystem.":workspace_roots"]', '"." = "write"',
                  '[permissions.replay.network]', 'enabled = false',
                  f'[projects.{q(str(workspace))}]', 'trust_level = "untrusted"'])
    return '\n'.join(lines) + '\n'


def probe(state, workspace, protected_files, project, binary, shared):
    q = lambda path: shlex.quote(str(path))
    records = workspace / 'probe-records'
    lines = ['set -eu', f'exec 3>{q(records)}',
             'record() { printf "%s=%s\\n" "$1" "$2" >&3; }',
             'if /bin/cat /proc/self/mountinfo > mountinfo 2>/dev/null; then record mountinfo available; else record mountinfo unavailable; fi',
             f'/bin/cat {q(state / "command-tmp" / "isolation-probe")} >/dev/null || exit 70',
             f'if /bin/ls {q(project)} >/dev/null 2>&1; then record project_listing exposed; exit 70; fi',
             'record project_listing denied']
    for index, path in enumerate(protected_files):
        lines.extend([f'if /bin/cat {q(path)} >/dev/null 2>&1; then record protected_{index} exposed; exit 70; fi',
                      f'record protected_{index} denied',
                      f'if (printf forbidden > {q(path)}) 2>/dev/null; then record protected_write_{index} synthetic_or_allowed; else record protected_write_{index} denied; fi'])
    lines.extend(['probe_status=0',
                  f'if {q(binary)} --version >/dev/null 2>&1; then record executable_version success; else record executable_version failed; probe_status=71; fi',
                  'test "$(/bin/cat README.md)" = fixture || exit 81',
                  'printf candidate > candidate-write', 'printf git-write > .git/replay-write',
                  f'printf private > {q(state / "command-tmp" / "private-write")}',
                  f'printf home > {q(state / "command-home" / "private-write")}',
                  f'test "$(/bin/cat {q(state / "command-tmp" / "private-write")})" = private || exit 82',
                  'record workspace_and_private_writes success',
                  f'if /bin/cat {q(shared)} >/dev/null 2>&1; then record shared_temp_read allowed; else record shared_temp_read denied; fi',
                  f'if (printf owned-write > {q(shared)}) 2>/dev/null; then record shared_temp_write allowed; else record shared_temp_write denied; fi',
                  'test "$probe_status" = 0 || exit "$probe_status"',
                  'printf ready > replay-ready', 'IFS= read -r release', 'test "$release" = release',
                  'record released yes'])
    return '\n'.join(lines)


def wait_ready(child, workspace):
    deadline = time.monotonic() + DEADLINE
    while time.monotonic() < deadline:
        if (workspace / 'replay-ready').exists():
            return 'ready'
        if child.poll() is not None:
            return 'exited-before-ready'
        time.sleep(0.02)
    return 'deadline-before-ready'


def stop(child):
    # The only group signalled is one created by this script with start_new_session.
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=5)


def release(child):
    if child.poll() is None:
        try:
            child.stdin.write(b'release\n')
            child.stdin.flush()
        except BrokenPipeError:
            pass
        try:
            child.wait(timeout=DEADLINE)
        except subprocess.TimeoutExpired:
            stop(child)


def run_policy(name, root, output, binary, shared):
    owned = root / name
    owned.mkdir(mode=0o700)
    states, children, receipts, originals = [], [], [], {}
    report = {'policy': name, 'snapshots': [{'point': 'before-admissions', **snapshot(states)}], 'invocations': receipts}
    try:
        for ordinal in range(2):
            state = owned / f'state-{ordinal}'
            state.mkdir(mode=0o700)
            states.append(state)
            for directory in ('home', 'tmp', 'command-home', 'command-tmp', 'codex-home'):
                (state / directory).mkdir(mode=0o700)
            workspace = owned / f'workspace-{ordinal}'
            workspace.mkdir(mode=0o700)
            (workspace / '.git').mkdir(mode=0o700)
            private_file(workspace / 'README.md', 'fixture\n')
            protected = [owned / f'{role}-{ordinal}' for role in ('project', 'results', 'source', 'login', 'peer')]
            for directory in protected:
                directory.mkdir(mode=0o700)
                private_file(directory / 'marker', 'synthetic-protected\n')
            protected_files = [path / 'marker' for path in protected]
            auth = state / 'codex-home' / 'auth.json'
            config = state / 'codex-home' / 'config.toml'
            private_file(auth, '{"OPENAI_API_KEY":"synthetic-replay-key"}\n')
            private_file(state / 'command-tmp' / 'isolation-probe', 'probe\n')
            protected.append(state / 'codex-home')
            config_text = profile(state, workspace, protected, binary, name == 'private-only')
            private_file(config, config_text)
            private_file(output / f'{name}-{ordinal}.toml', config_text)
            protected_files.extend([auth, config])
            originals.update({path: hashlib.sha256(bounded(path)).hexdigest() for path in protected_files})
            arguments = [str(binary), 'sandbox', '-P', 'replay', '-C', str(workspace),
                         '/bin/sh', '-c', probe(state, workspace, protected_files,
                                               protected[0], binary, shared)]
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(state / 'home'),
                   'TMPDIR': str(state / 'tmp'), 'CODEX_HOME': str(state / 'codex-home'), 'NO_COLOR': '1'}
            out_path, err_path = output / f'{name}-{ordinal}.stdout', output / f'{name}-{ordinal}.stderr'
            with out_path.open('wb') as stdout, err_path.open('wb') as stderr:
                child = subprocess.Popen(arguments, cwd=workspace, env=env, stdin=subprocess.PIPE,
                                         stdout=stdout, stderr=stderr, start_new_session=True)
            children.append(child)
            receipts.append({'ordinal': ordinal, 'pid': child.pid, 'admission': wait_ready(child, workspace)})
            report['snapshots'].append({'point': f'after-admission-{ordinal}', **snapshot(states)})
        release(children[0])
        report['snapshots'].append({'point': 'after-A-exit-before-B-release',
                                    'B_alive': children[1].poll() is None, **snapshot(states)})
        release(children[1])
    finally:
        for child in children:
            stop(child)
        report['snapshots'].append({'point': 'after-both-exit', **snapshot(states)})
        for ordinal, child in enumerate(children):
            workspace = owned / f'workspace-{ordinal}'
            receipts[ordinal]['exit_code'] = child.returncode
            for item in ('stdout', 'stderr'):
                receipts[ordinal][item + '_bytes'] = len(bounded(output / f'{name}-{ordinal}.{item}'))
            records = workspace / 'probe-records'
            receipts[ordinal]['probe_records'] = bounded(records).decode().splitlines() if records.exists() else []
            mountinfo = workspace / 'mountinfo'
            receipts[ordinal]['shared_metadata_mounts'] = [line for line in bounded(mountinfo).decode().splitlines()
                                                         if any(str(path) in line.split() for path in SHARED_TARGETS)] if mountinfo.exists() else None
        report['protected_originals_unchanged'] = all(path.exists() and hashlib.sha256(bounded(path)).hexdigest() == digest
                                                    for path, digest in originals.items())
        private_file(output / f'{name}.json', json.dumps(report, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--codex', default=shutil.which('codex'))
    parser.add_argument('--output', required=True)
    options = parser.parse_args()
    if sys.platform != 'linux':
        parser.error('requires actual Linux; platform simulation is not supported')
    if not options.codex:
        parser.error('the configured pinned Codex executable is required')
    binary = Path(options.codex).resolve(strict=True)
    output = Path(options.output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    root = Path(tempfile.mkdtemp(prefix='sevro-policy-replay-', dir='/var/tmp'))
    shared_root = Path(tempfile.mkdtemp(prefix='sevro-policy-replay-shared-', dir='/tmp'))
    shared = shared_root / 'owned-marker'
    try:
        version = subprocess.run([binary, '--version'], capture_output=True, timeout=10,
                                 env={'PATH': '/usr/bin:/bin', 'HOME': str(root), 'TMPDIR': str(root)})
        if version.returncode != 0 or version.stdout.strip() != b'codex-cli 0.160.1':
            raise RuntimeError('requires exactly codex-cli 0.160.1')
        results = []
        for name in ('current', 'private-only'):
            private_file(shared, 'owned-shared-marker\n')
            results.append(run_policy(name, root, output, binary, shared))
        private_file(output / 'summary.json', json.dumps({'version': '0.160.1', 'results': results}, indent=2) + '\n')
        print(json.dumps({'observation_complete': True, 'output': str(output),
                          'results': [{'policy': item['policy'], 'protected_originals_unchanged': item['protected_originals_unchanged'],
                                       'invocations': item['invocations']} for item in results]}))
    finally:
        shutil.rmtree(root)
        shutil.rmtree(shared_root)


if __name__ == '__main__':
    main()
