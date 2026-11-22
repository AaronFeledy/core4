export const PYTHON_UV_PIN = {
  version: "0.13.9",
  hashes: [
    "5435c5ce14a56431208ca0996416d310f1598e8c2c8ba707688985a16bb82dbe",
    "d7f459fe4fd247d830351c75686d3996ace3c6f3f728eb0e85a30b7ada0cef19",
    "ecb6028d79dc96fbeafffe5c8af62a7099487ebc05a701e76714eebcffd06375",
    "2c45530751517d6c3bbc69a19473f6effe47cce047bede01ffd8af7ea7b36b25",
  ],
} as const;

export const PYTHON_PREPARE_SCRIPT = String.raw`set -eu
exec /usr/local/bin/python -I -S - "$1" "$2" "$3" <<'PY'
import hashlib
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

BASE = '/usr/local/bin/python'
UV = '/usr/local/bin/uv'
REVISION = b'1'
ROOT = Path.cwd().resolve()
TARGET = Path(sys.argv[1])
UV_VERSION = sys.argv[2]
OWNER = sys.argv[3]
PYTHON = TARGET / 'bin/python'
MARKER = TARGET / '.lando-dependencies'
REQUIREMENTS = ROOT / 'requirements.txt'

def refuse_nested_mounts() -> None:
    with open('/proc/self/mountinfo', encoding='utf-8') as mounts:
        for line in mounts:
            mount = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), line.split()[4])
            if mount.startswith(str(TARGET).rstrip('/') + '/'):
                sys.exit(f'Refusing to prepare {TARGET}: nested mount at {mount}')
    if TARGET.resolve() != TARGET:
        sys.exit(f'Refusing to prepare a symlinked environment: {TARGET}')

def valid_venv() -> bool:
    if not (TARGET / 'pyvenv.cfg').is_file() or not PYTHON.is_file():
        return False
    check = 'import os,sys; print((sys.prefix, sys.version_info[:2], os.path.realpath(sys._base_executable)))'
    result = subprocess.run([PYTHON, '-I', '-c', check], capture_output=True, text=True, check=False)
    expected = repr((str(TARGET), sys.version_info[:2], os.path.realpath(BASE))) + '\n'
    return result.returncode == 0 and result.stdout == expected

def include_paths(contents: bytes):
    text = re.sub(r'\\\r?\n', '', contents.decode('utf-8-sig'))
    for line in text.splitlines():
        if not line.lstrip().startswith(('-r', '-c', '--requirement', '--constraint')):
            continue
        values = shlex.split(line, comments=True)
        if not values:
            continue
        option, *args = values
        if option in ('-r', '-c', '--requirement', '--constraint'):
            if len(args) != 1:
                sys.exit('Expected exactly one path after ' + option)
            yield args[0]
        elif option.startswith(('--requirement=', '--constraint=')):
            yield option.split('=', 1)[1]
        elif option.startswith(('-r', '-c')):
            yield option[2:].removeprefix('=')

def digest() -> tuple[str, bool]:
    has_inputs = REQUIREMENTS.exists() or REQUIREMENTS.is_symlink()
    hashed = hashlib.sha256()
    seen: set[Path] = set()
    active: set[Path] = set()

    def frame(value: bytes) -> None:
        hashed.update(len(value).to_bytes(8, 'big'))
        hashed.update(value)

    def visit(path: Path, depth: int) -> None:
        resolved = path.resolve()
        if not resolved.is_relative_to(ROOT):
            sys.exit(f'Requirements include is outside the app root: {path}')
        if depth > 16 or (len(seen) >= 128 and path not in seen) or path in active:
            sys.exit(f'Requirements include limit or cycle at {path}')
        if path in seen:
            return
        if not resolved.is_file():
            sys.exit(f'Requirements file is missing or not a regular file: {path}')
        contents = resolved.read_bytes()
        frame(os.fsencode(path.relative_to(ROOT)))
        frame(contents)
        seen.add(path)
        active.add(path)
        for child in include_paths(contents):
            expanded = os.path.expandvars(child)
            if '://' in expanded:
                sys.exit(f'Requirements includes must be local to the app: {path}')
            visit(Path(os.path.abspath(path.parent / expanded)), depth + 1)
        active.remove(path)

    for value in (b'requirements' if has_inputs else b'no-inputs', REVISION, sys.version.encode(), UV_VERSION.encode()):
        frame(value)
    if has_inputs:
        visit(REQUIREMENTS, 0)
    return hashed.hexdigest(), has_inputs

def main() -> None:
    refuse_nested_mounts()
    valid = valid_venv()
    previous = MARKER.read_text().strip() if valid and not MARKER.is_symlink() and MARKER.is_file() else None
    try:
        expected, has_inputs = digest()
    except (OSError, ValueError, RuntimeError, SystemExit):
        MARKER.unlink(missing_ok=True)
        raise
    if valid and previous == expected:
        print('Python dependencies are up to date.', flush=True)
        return
    MARKER.unlink(missing_ok=True)
    marker_path: Path | None = None
    try:
        try:
            if not valid:
                print(f'Preparing Python environment at {TARGET}.', flush=True)
                subprocess.run([BASE, '-I', '-m', 'venv', '--clear', '--system-site-packages', TARGET], check=True)
            if has_inputs:
                print('Installing requirements.txt.', flush=True)
                subprocess.run([UV, 'pip', 'install', '--python', PYTHON, '-r', 'requirements.txt'],
                               env={**os.environ, 'UV_LINK_MODE': 'copy'}, check=True)
            if digest()[0] != expected:
                sys.exit('Requirements changed during preparation. Restart to retry.')
            with tempfile.NamedTemporaryFile(mode='w', dir=TARGET, delete=False) as marker:
                marker_path = Path(marker.name)
                marker.write(expected + '\n')
            marker_path.chmod(0o644)
        finally:
            subprocess.run(['/usr/bin/chown', '-hR', '--', OWNER, TARGET], check=True)
        marker_path.replace(MARKER)
    finally:
        if marker_path is not None:
            marker_path.unlink(missing_ok=True)

try:
    main()
except subprocess.CalledProcessError as error:
    sys.exit(error.returncode)
except (OSError, ValueError, RuntimeError) as error:
    sys.exit(f'Could not prepare Python dependencies: {error}')
PY`;
