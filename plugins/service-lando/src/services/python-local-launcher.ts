import type { ServiceLaunchers } from "@lando/sdk/services";

// Python's stat/lstat distinguish missing files, broken links, and permission
// errors. A shell's file predicates would collapse those into the same result.
const PYTHON_LOCAL_SCRIPT = `
import os
import stat
import sys
from pathlib import Path

def regular_file(path: Path) -> bool:
    try:
        mode = path.stat().st_mode
    except FileNotFoundError:
        try:
            path.lstat()
        except FileNotFoundError:
            return False
        raise OSError(f"Broken file link: {str(path)!r}") from None
    if not stat.S_ISREG(mode):
        raise OSError(f"Not a regular file: {str(path)!r}")
    return True

try:
    args = sys.argv[1:]
    if not args:
        raise OSError("Missing command after the launcher")

    mount = os.environ.get("LANDO_APP_ROOT")
    app_root = Path(os.path.realpath(mount, strict=True)) if mount else None
    cwd = Path.cwd()
    for directory in (cwd, *cwd.parents):
        manifest = directory / "pyproject.toml"
        if regular_file(manifest):
            with manifest.open("rb"):
                pass
            os.execvp("uv", ["uv", "run", "--", *args])
        if directory == app_root:
            break

    if app_root is not None:
        venv = app_root / ".venv"
        interpreter = venv / "bin" / "python"
        if regular_file(interpreter) and os.access(interpreter, os.X_OK, effective_ids=True):
            os.environ["VIRTUAL_ENV"] = str(venv)
            os.environ["PATH"] = os.pathsep.join([str(interpreter.parent), *os.get_exec_path()])
            os.environ.pop("PYTHONHOME", None)

    os.execvp(args[0], args)
except OSError as error:
    sys.exit("python-local: " + " ".join(str(error).splitlines()))
`.trim();

export const pythonServiceLaunchers = {
  ":python-local": ["python", "-I", "-S", "-c", PYTHON_LOCAL_SCRIPT],
} as const satisfies ServiceLaunchers;
