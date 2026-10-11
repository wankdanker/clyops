"""Command dispatch for the browser's real Python examples (also tested natively)."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import shlex
import sys

ROOT = Path.cwd()
TOOLS = ("plan.py", "report.py", "json-format.py")
BASH_TOOLS = ("media-info.sh", "transcode.sh", "upload.sh")
HELP = """Python playground — real clyops scripts, running in this browser.
Commands: plan.py, report.py, json-format.py, ls, cat PATH, pwd, help, clear
Also accepts: python examples/scripts/plan.py --help
Tab completes commands, options and choices. ↑/↓ recall commands.
The stdin panel supplies input to json-format.py when --input is omitted.
Bash, FFmpeg, curl, pipes and a host shell are available in the local examples,
not this Python playground. Use Reset to stop execution and unload the runtime.
"""


def _path(value):
    path = (ROOT / value).resolve()
    if path != ROOT and ROOT not in path.parents:
        raise ValueError("Choose a file in the playground workspace")
    return path


def _invoke(words, stdin):
    if words[0] in ("python", "python3"):
        words = words[1:]
    if not words:
        raise ValueError("Choose a Python example, e.g. plan.py --help")
    if words[0] == "bash" or Path(words[0]).name in BASH_TOOLS:
        name = Path(words[1]).name if words[0] == "bash" and len(words) > 1 else Path(words[0]).name
        example = name if name in BASH_TOOLS else "upload.sh"
        raise ValueError(
            "Bash is not loaded in this Python playground. These Bash examples run locally.\n"
            f"View source: cat examples/scripts/{example}\n"
            f"From a cloned checkout: ./examples/scripts/{example} --help"
        )
    name = Path(words[0]).name
    if name not in TOOLS or words[0] not in (name, "./" + name, "examples/scripts/" + name, "./examples/scripts/" + name):
        raise ValueError("Available Python tools: " + ", ".join(TOOLS))
    old_argv, old_stdin = sys.argv, sys.stdin
    stdout, stderr = io.StringIO(), io.StringIO()
    code = 0
    try:
        sys.argv = [name, *words[1:]]
        sys.stdin = io.StringIO(stdin)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                runpy.run_path(str(ROOT / "examples/scripts" / name), run_name="__main__")
            except SystemExit as error:
                code = error.code if isinstance(error.code, int) else int(bool(error.code))
                if isinstance(error.code, str):
                    print(error.code, file=sys.stderr)
    finally:
        sys.argv, sys.stdin = old_argv, old_stdin
    return {"stdout": stdout.getvalue()[:60000], "stderr": stderr.getvalue()[:60000], "code": code}


def execute(command, stdin=""):
    """Run supported commands without starting a shell or evaluating user code."""
    try:
        if len(command) > 4000 or len(stdin) > 32000:
            raise ValueError("Command or stdin is too long")
        words = shlex.split(command)
        if not words:
            return {"stdout": "", "stderr": "", "code": 0}
        if words == ["help"]:
            output = HELP
        elif words == ["pwd"]:
            output = str(ROOT) + "\n"
        elif words == ["clear"]:
            return {"stdout": "", "stderr": "", "code": 0, "clear": True}
        elif words[0] == "ls" and len(words) <= 2:
            path = _path(words[1]) if len(words) == 2 else ROOT / "examples/scripts"
            output = "\n".join(
                item.name + ("/" if item.is_dir() else "")
                + ("  [Bash source; run locally]" if item.name in BASH_TOOLS else "")
                for item in sorted(path.iterdir())
            ) + "\n"
        elif words[0] == "cat" and len(words) == 2:
            output = _path(words[1]).read_text()[:60000]
        else:
            return _invoke(words, stdin)
        return {"stdout": output, "stderr": "", "code": 0}
    except Exception as error:
        return {"stdout": "", "stderr": str(error) + "\n", "code": 1}


def complete(command):
    """Get options and choice candidates from each script's completion protocol."""
    try:
        words = shlex.split(command)
        if not words or (len(words) == 1 and not command.endswith(" ")):
            prefix = words[0] if words else ""
            return [word for word in (*TOOLS, "help", "ls", "cat", "pwd", "clear") if word.startswith(prefix)]
        if words[0] in ("python", "python3"):
            words = words[1:]
        if not words:
            return list(TOOLS)
        prefix = "" if command.endswith(" ") else words[-1]
        before = words if command.endswith(" ") else words[:-1]
        records = _invoke([words[0], "--bash-completion", "--", *before[1:]], "")["stdout"].splitlines()
        candidates = ["--help-json-schema", "--completion"]
        for record in records:
            fields = record.split("\t")
            if len(fields) < 7 or fields[0] != "opt":
                continue
            if len(before) > 1 and before[-1] in fields[1:3] and fields[4] == "choice":
                return [value for value in fields[5].split(",") if value.startswith(prefix)]
            candidates.extend(value for value in fields[1:3] if value != "-")
        return sorted(set(value for value in candidates if value.startswith(prefix)))
    except (ValueError, OSError):
        return []


def request(payload):
    """JSON boundary shared with the Web Worker."""
    data = json.loads(payload)
    if data["action"] == "complete":
        result = {"candidates": complete(data["command"])}
    else:
        result = execute(data["command"], data.get("stdin", ""))
    return json.dumps(result)
