"""clyops — declarative CLI parsing for Python. Behavior follows spec/SPEC.md.

    from clyops import Cli

    cli = Cli()
    cli.arg("input", "Input file", rule="path")
    cli.opt("PORT", "port", "p", "8080", "Server port", group="Network", rule="port")
    cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output")
    args = cli.run()
    print(args.input, args.PORT, args.VERBOSE)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass, field
from typing import Dict, List, Mapping, NoReturn, Optional, Sequence, Union

from ._completions import SCRIPTS as _COMPLETION_SCRIPTS

__all__ = [
    "Cli", "Values", "ParseResult", "ValidationError", "validate", "resolve_path", "describe_rule", "wrap_text",
    "is_executable", "is_bare_program", "is_json",
    "info", "warn", "error", "success", "die", "set_silent",
]
__version__ = "0.10.0"

Scalar = Union[str, int, float, bool]
Value = Union[Scalar, List[Scalar], None]

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_COLORS = {"info": "\033[1;37m", "warning": "\033[0;33m", "error": "\033[0;31m", "success": "\033[0;32m"}
_silent = os.environ.get("CLYOPS_SILENT") == "true"


def set_silent(value: bool) -> None:
    """Suppress info/warn/error/success output (die and parse errors still print)."""
    global _silent
    _silent = value


def _emit(level: str, msg: str, force: bool = False) -> None:
    if _silent and not force:
        return
    tag = level
    if sys.stderr.isatty() and not os.environ.get("NO_COLOR"):
        tag = f"{_COLORS[level]}{level}\033[0m"
    sys.stderr.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [{tag}] {msg}\n")


def info(msg: str) -> None:
    """Write a timestamped informational message to stderr."""
    _emit("info", msg)


def warn(msg: str) -> None:
    """Write a timestamped warning to stderr."""
    _emit("warning", msg)


def error(msg: str) -> None:
    """Write a timestamped error to stderr."""
    _emit("error", msg)


def success(msg: str) -> None:
    """Write a timestamped success message to stderr."""
    _emit("success", msg)


def die(code: int, msg: str) -> NoReturn:
    """Print an error and exit with `code`. Never suppressed."""
    _emit("error", msg, force=True)
    sys.exit(code)


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

_TRUE = ("true", "yes", "1", "on")
_FALSE = ("false", "no", "0", "off")
_FIXED_RULES = {
    "int", "float", "string", "path", "ip", "hostname", "url", "port", "email", "uuid", "json", "bool",
    "date:YYYY-MM-DD", "file:exists", "file:readable", "file:writable", "file:executable", "dir:exists", "dir:writable",
}
_JSON_MAX_DEPTH = 512
_JSON_HEX = re.compile(r"[0-9a-fA-F]{4}")


def is_json(text: str) -> bool:
    """Whether ``text`` is exactly one JSON value, by the grammar in spec section 5."""
    n = len(text)
    i = 0

    def skip_space() -> None:
        nonlocal i
        while i < n and text[i] in " \t\n\r":
            i += 1

    def at(k: int) -> str:
        return text[k] if k < n else ""

    def digits() -> bool:
        nonlocal i
        start = i
        while i < n and "0" <= text[i] <= "9":
            i += 1
        return i > start

    def string() -> bool:
        nonlocal i
        i += 1
        while i < n:
            c = text[i]
            if c == '"':
                i += 1
                return True
            if c < " ":
                return False
            if c == "\\":
                e = at(i + 1)
                if e and e in '"\\/bfnrt':
                    i += 2
                elif e == "u" and _JSON_HEX.fullmatch(text[i + 2:i + 6]):
                    i += 6
                else:
                    return False
            else:
                i += 1
        return False

    def number() -> bool:
        nonlocal i
        if at(i) == "-":
            i += 1
        if at(i) == "0":
            i += 1
        elif not ("1" <= at(i) <= "9") or not digits():
            return False
        if at(i) == ".":
            i += 1
            if not digits():
                return False
        if at(i) in ("e", "E"):
            i += 1
            if at(i) in ("+", "-"):
                i += 1
            if not digits():
                return False
        return True

    def value(depth: int) -> bool:
        nonlocal i
        skip_space()
        c = at(i)
        if c in ("{", "["):
            if depth >= _JSON_MAX_DEPTH:
                return False
            close = "}" if c == "{" else "]"
            i += 1
            skip_space()
            if at(i) == close:
                i += 1
                return True
            while True:
                if c == "{":
                    skip_space()
                    if at(i) != '"' or not string():
                        return False
                    skip_space()
                    if at(i) != ":":
                        return False
                    i += 1
                if not value(depth + 1):
                    return False
                skip_space()
                if at(i) == ",":
                    i += 1
                    continue
                if at(i) == close:
                    i += 1
                    return True
                return False
        if c == '"':
            return string()
        if c == "-" or "0" <= c <= "9":
            return number()
        for word in ("true", "false", "null"):
            if text.startswith(word, i):
                i += len(word)
                return True
        return False

    if not value(0):
        return False
    skip_space()
    return i == n


_HOSTNAME = r"[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*"


_ROLE_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_.-]*")
_EFFECTS = ("read-only", "idempotent", "destructive", "network")


def _bool_word(value: str) -> Optional[bool]:
    lower = value.lower()
    if lower in _TRUE:
        return True
    if lower in _FALSE:
        return False
    return None


def _known_rule(rule: str) -> bool:
    if not rule or rule in _FIXED_RULES:
        return True
    if re.fullmatch(r"int:(\d+-\d*|-\d+)", rule) or re.fullmatch(r"float:(\d*\.?\d+-(\d*\.?\d+)?|-\d*\.?\d+)", rule):
        return True
    if re.fullmatch(r"string:(\d+|\d+-\d*|-\d+)", rule) or re.fullmatch(r"choice:.+", rule):
        return True
    if rule.startswith("regex:") and len(rule) > 6:
        try:
            re.compile(rule[6:])
            return True
        except re.error:
            return False
    if rule.startswith("json:") and len(rule) > 5:
        return not rule.startswith("json:{") or is_json(rule[5:])
    return False


# A scheme such as `https:` (spec section 6).
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]+:")


def _rule_schema(rule: str, root: str, name: str) -> object:
    """The JSON Schema a `json:SCHEMA` rule names (spec section 5), or None: inline
    JSON, `{"$ref": URL}`, or a file read relative to `root`. A file that can't be
    read or isn't JSON is a warning and None."""
    if not rule.startswith("json:"):
        return None
    spec = rule[5:]
    if spec.startswith("{"):
        return json.loads(spec)
    if _SCHEME.match(spec):
        return {"$ref": spec}
    path = os.path.normpath(os.path.join(root, spec))
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        if is_json(text):
            return json.loads(text)
    except (OSError, UnicodeDecodeError):
        pass
    _emit("warning", f"{name} schema is not a readable JSON file: {path}", force=True)
    return None


def _bounds(rule: str):
    rng = rule.split(":", 1)[1]
    lo, _, hi = rng.partition("-")
    return lo, hi


def _is_path_rule(rule: str) -> bool:
    return rule == "path" or rule.startswith(("file:", "dir:"))


def is_bare_program(value: str) -> bool:
    """A `file:executable` value naming a program on PATH rather than a path (spec section 5)."""
    return value != "" and "/" not in value and not (os.name == "nt" and "\\" in value)


def _is_executable_file(path: str) -> bool:
    # A regular file the user may run; Windows has no execute bit, so one that exists.
    return os.path.isfile(path) and (os.name == "nt" or os.access(path, os.X_OK))


def is_executable(value: str, env: Optional[Mapping[str, str]] = None) -> bool:
    """Whether `value` is a program: a bare name found on PATH, or a path to an executable regular file."""
    if not is_bare_program(value):
        return _is_executable_file(value)
    env = os.environ if env is None else env
    exts = [""] + [e for e in env.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(";") if e] if os.name == "nt" else [""]
    for directory in env.get("PATH", "").split(os.pathsep):
        if directory and any(_is_executable_file(os.path.join(directory, value + ext)) for ext in exts):
            return True
    return False


def describe_rule(rule: str) -> str:
    """Help text for a validation rule (spec section 5)."""
    fixed = {
        "int": "integer", "float": "number", "string": "text", "path": "path", "ip": "IP address",
        "hostname": "hostname", "url": "URL", "port": "port: 1-65535", "email": "email address", "uuid": "UUID", "json": "JSON",
        "bool": "true/false, yes/no, 1/0, on/off", "date:YYYY-MM-DD": "date: YYYY-MM-DD",
        "file:exists": "existing file", "file:readable": "readable file", "file:writable": "writable file",
        "file:executable": "executable", "dir:exists": "existing directory", "dir:writable": "writable directory",
    }
    if rule in fixed:
        return fixed[rule]
    for prefix, noun, suffix in (("int:", "integer", ""), ("float:", "number", ""), ("string:", "text", " chars")):
        if rule.startswith(prefix):
            if "-" not in rule:
                return f"{noun}: {rule[len(prefix):]}{suffix}"
            lo, hi = _bounds(rule)
            if lo and hi:
                return f"{noun}: {lo}-{hi}{suffix}"
            return f"{noun}: >={lo}{suffix}" if lo else f"{noun}: <={hi}{suffix}"
    if rule.startswith("choice:"):
        return "choices: " + ", ".join(rule[7:].split(","))
    if rule.startswith("regex:"):
        return "pattern: " + rule[6:]
    if rule.startswith("json:"):
        return "JSON" if rule.startswith("json:{") else "JSON: " + rule[5:]
    return rule


class ValidationError(ValueError):
    """An invalid value reported with the validation rule and option or argument name."""
    pass


def validate(value: str, rule: str, name: str) -> Scalar:
    """Validate `value` against `rule` and return its typed form.

    Raises ValidationError with the spec's error text.
    """
    def fail(msg: str):
        raise ValidationError(f"{name} {msg}")

    def check_bounds(num: float, lo: str, hi: str):
        if lo and num < float(lo):
            fail(f"must be >= {lo}, got {value}")
        if hi and num > float(hi):
            fail(f"must be <= {hi}, got {value}")

    if rule == "int" or rule.startswith("int:"):
        if not re.fullmatch(r"-?[0-9]+", value):
            fail(f"must be an integer, got '{value}'")
        num: Union[int, float] = int(value)
        if rule != "int":
            check_bounds(num, *_bounds(rule))
        return num
    if rule == "float" or rule.startswith("float:"):
        if not re.fullmatch(r"-?[0-9]*\.?[0-9]+", value):
            fail(f"must be a number, got '{value}'")
        num = float(value)
        if rule != "float":
            check_bounds(num, *_bounds(rule))
        return num
    if rule.startswith("string:"):
        length = len(value)
        if "-" not in rule:
            exact = rule[7:]
            if length != int(exact):
                fail(f"must be exactly {exact} characters, got {length}")
        else:
            lo, hi = _bounds(rule)
            if lo and length < int(lo):
                fail(f"must be at least {lo} characters, got {length}")
            if hi and length > int(hi):
                fail(f"must be at most {hi} characters, got {length}")
        return value
    if rule.startswith("choice:"):
        choices = rule[7:].split(",")
        if value not in choices:
            fail(f"must be one of: {', '.join(choices)}, got '{value}'")
        return value
    if rule.startswith("regex:"):
        if not re.search(rule[6:], value):
            fail(f"does not match required pattern, got '{value}'")
        return value
    if rule.startswith("json:"):
        rule = "json"

    if rule == "bool":
        b = _bool_word(value)
        if b is None:
            fail(f"must be a boolean (true/false, yes/no, 1/0, on/off), got '{value}'")
        return bool(b)
    if rule == "port":
        if not re.fullmatch(r"[0-9]+", value) or not 1 <= int(value) <= 65535:
            fail(f"must be a valid port (1-65535), got '{value}'")
        return int(value)
    if rule == "ip":
        if not (re.fullmatch(r"([0-9]{1,3}\.){3}[0-9]{1,3}", value)
                or re.fullmatch(r"([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}", value)):
            fail(f"must be a valid IP address, got '{value}'")
    elif rule == "hostname":
        if not re.fullmatch(_HOSTNAME, value):
            fail(f"must be a valid hostname, got '{value}'")
    elif rule == "url":
        if not re.fullmatch(r"https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?", value, re.S):
            fail(f"must be a valid URL, got '{value}'")
    elif rule == "email":
        if not re.fullmatch(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", value):
            fail(f"must be a valid email address, got '{value}'")
    elif rule == "uuid":
        if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", value):
            fail(f"must be a valid UUID, got '{value}'")
    elif rule == "json":
        if not is_json(value):
            fail(f"must be valid JSON, got '{value}'")
    elif rule == "date:YYYY-MM-DD":
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
            fail(f"must be in YYYY-MM-DD format, got '{value}'")
    elif rule == "file:exists":
        if not os.path.isfile(value):
            fail(f"file does not exist: {value}")
    elif rule == "file:readable":
        if not os.access(value, os.R_OK):
            fail(f"file is not readable: {value}")
    elif rule == "file:writable":
        if os.path.lexists(value):
            if not os.access(value, os.W_OK):
                fail(f"file is not writable: {value}")
        else:
            directory = os.path.dirname(value)
            if not (os.path.isdir(directory) and os.access(directory, os.W_OK)):
                fail(f"directory is not writable: {directory}")
    elif rule == "file:executable":
        if not is_executable(value):
            fail(f"is not an executable: {value}")
    elif rule == "dir:exists":
        if not os.path.isdir(value):
            fail(f"directory does not exist: {value}")
    elif rule == "dir:writable":
        if not (os.path.isdir(value) and os.access(value, os.W_OK)):
            fail(f"directory does not exist or is not writable: {value}")
    return value


def resolve_path(value: str, base: str, search_dirs: Sequence[str] = ()) -> str:
    """Resolve a path value against `base` (spec section 6)."""
    if not value or value in ("-", "disabled", "optional"):
        return value
    if os.path.isabs(value) or re.match(r"[A-Za-z][A-Za-z0-9+.-]+:", value):
        return value
    from_base = os.path.normpath(os.path.join(base, value))
    bare = not re.match(r"\.\.?(/|$)", value)
    if bare and search_dirs and not os.path.exists(from_base):
        for directory in search_dirs:
            candidate = os.path.normpath(os.path.join(directory, value))
            if os.path.exists(candidate):
                return candidate
    return from_base


def wrap_text(text: str, width: int) -> List[str]:
    """Greedy word wrap that keeps existing line breaks (spec section 7)."""
    out: List[str] = []
    for original in re.split(r"\r?\n", text):
        words = original.split()
        if not words:
            out.append("")
            continue
        line = ""
        for word in words:
            if not line:
                line = word
            elif len(line) + 1 + len(word) <= width:
                line += " " + word
            else:
                out.append(line)
                line = word
        out.append(line)
    return out


def _completion_kind(rule: str, search_dirs: Sequence[str]):
    if rule == "file:executable":
        return "command", ":".join(search_dirs)
    if rule == "path" or rule.startswith("file:"):
        return "file", ":".join(search_dirs)
    if rule.startswith("dir:"):
        return "dir", ":".join(search_dirs)
    if rule.startswith("choice:"):
        return "choice", rule[7:]
    if rule == "bool":
        return "choice", "true,false"
    if rule in ("hostname", "ip"):
        return "host", ""
    return ("none", "") if rule else ("default", "")


# ---------------------------------------------------------------------------
# Cli
# ---------------------------------------------------------------------------

@dataclass
class _Option:
    var: str
    long: str
    short: str
    kind: str  # flag | value | array
    default: str
    required: bool
    description: str
    group: str
    rule: str
    search_dirs: List[str] = field(default_factory=list)
    secret: bool = False

    @property
    def label(self) -> str:
        head = f"-{self.short}, --{self.long}" if self.short else f"    --{self.long}"
        return head if self.kind == "flag" else head + "=<value>"

    @property
    def bool_like(self) -> bool:
        return self.kind == "flag" or self.rule in ("bool", "choice:true,false", "choice:false,true")


@dataclass
class _Arg:
    name: str
    description: str
    default: str
    rule: str
    variadic: bool


@dataclass
class ParseResult:
    """Non-exiting parse outcome. status is ok, help, or error; error/detail explain failures and show_usage controls help."""
    status: str  # ok | help | error
    error: str = ""
    show_usage: bool = True
    detail: List[str] = field(default_factory=list)


class Values(Dict[str, Value]):
    """Resolved values; keys are option vars and argument names, also readable as attributes."""

    def __getattr__(self, name: str) -> Value:
        """Read a resolved key as an attribute; missing keys raise AttributeError."""
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None


class _ParseError(Exception):
    pass


class Cli:
    """A program CLI. Register options and arguments, then call run or parse. Resolved names are runtime keys."""
    def __init__(self, name: Optional[str] = None, root: Optional[str] = None, cwd: Optional[str] = None,
                 env: Optional[Mapping[str, str]] = None):
        """Create a CLI. name defaults to argv[0], cwd to the working directory, root to cwd, and env to os.environ."""
        self.name = name or os.path.basename(sys.argv[0] or "cli")
        self.cwd = cwd or os.getcwd()
        self.root = os.path.normpath(os.path.join(self.cwd, root or "."))
        self.env = os.environ if env is None else env
        self.description = ""
        self.epilog = ""
        self.values = Values()
        self._options: List[_Option] = []
        self._by_long: Dict[str, _Option] = {}
        self._by_short: Dict[str, _Option] = {}
        self._args: List[_Arg] = []
        self._commands: List[tuple] = []
        self._config_option = ""
        self._config_prefixes: List[str] = []
        self._raw: Dict[str, Union[str, List[str]]] = {}
        self._arg_raw: Dict[str, Union[str, List[str]]] = {}
        self._sources: Dict[str, str] = {}
        self._config: Dict[str, tuple] = {}  # key -> (value, dir)
        self._effects: List[str] = []
        self._stdin: Optional[Dict[str, str]] = None
        self._stdout: Optional[Dict[str, str]] = None
        self._roles: List[Dict[str, object]] = []
        self._fd_map: Optional[Dict[str, int]] = None  # CLYOPS_FDS as read once (spec section 14)
        self._constraints: List[Dict[str, object]] = []
        self._children: List["Cli"] = []
        self._parent: Optional["Cli"] = None
        self._word = ""
        # The command selected by the last parse (this one when it has no commands).
        self._selected: "Cli" = self

    # -- registration ---------------------------------------------------------

    def set_description(self, text: str) -> "Cli":
        """Set the help description and return this CLI."""
        self.description = text
        return self

    def set_epilog(self, text: str) -> "Cli":
        """Set the final help text and return this CLI."""
        self.epilog = text
        return self

    def set_effects(self, *effects: str) -> "Cli":
        """What running the program does: read-only, idempotent, destructive, network."""
        for e in effects:
            if e not in _EFFECTS:
                raise ValueError(f"Unknown effect '{e}'")
        self._effects = list(effects)
        return self

    def set_stdin(self, description: str, content_type: str = "") -> "Cli":
        """What the program reads on stdin; `content_type` is a MIME type or a comma-separated list."""
        self._stdin = {"description": description, "contentType": content_type}
        return self

    def set_stdout(self, description: str, content_type: str = "") -> "Cli":
        """What the program writes on stdout; undeclared means text."""
        self._stdout = {"description": description, "contentType": content_type}
        return self

    def role(self, name: str, direction: str, description: str, content_type: str = "",
             schema: object = None) -> "Cli":
        """Declare a role (spec section 1.3): a stream the program writes ("out") or reads ("in") on a
        descriptor its runner chooses. `name` is meta, progress, log, result or another agreed name;
        `schema` is a JSON Schema (dict or JSON text) for each document or line."""
        if not _ROLE_NAME.fullmatch(name):
            raise ValueError(f"Invalid role name '{name}'")
        if direction not in ("in", "out"):
            raise ValueError(f"Unknown role direction '{direction}'")
        if any(r["name"] == name for r in self._roles):
            raise ValueError(f"Duplicate role '{name}'")
        if isinstance(schema, str):
            schema = json.loads(schema)
        self._roles.append({"name": name, "direction": direction, "description": description,
                            "contentType": content_type, "schema": schema})
        return self

    def _find_role(self, name: str) -> Optional[Dict[str, object]]:
        """The declared role, searching the selected command then its ancestors."""
        for node in self._chain():
            for r in node._roles:
                if r["name"] == name:
                    return r
        return None

    def _fd_mapping(self) -> Dict[str, int]:
        """CLYOPS_FDS, read once on the program and then removed from the process environment."""
        top = self
        while top._parent is not None:
            top = top._parent
        if top._fd_map is not None:
            return top._fd_map
        mapping: Dict[str, int] = {}
        raw = top.env.get("CLYOPS_FDS")
        for entry in (e.strip() for e in (raw or "").split(",")):
            if not entry:
                continue
            m = re.fullmatch(r"([A-Za-z][A-Za-z0-9_.-]*):([0-9]+)", entry)
            if m is None or int(m.group(2)) < 2:
                warn(f"Ignoring CLYOPS_FDS entry '{entry}'")
            else:
                mapping[m.group(1)] = int(m.group(2))
        if raw is not None and os.environ.get("CLYOPS_FDS") == raw:
            del os.environ["CLYOPS_FDS"]
        top._fd_map = mapping
        return mapping

    def _mapped_fd(self, name: str) -> Optional[int]:
        """The descriptor CLYOPS_FDS maps to `name`, when it is open."""
        num = self._fd_mapping().get(name)
        if num is None or os.name != "posix":
            return None
        try:
            os.fstat(num)
        except OSError:
            return None
        return num

    def _warn_unopened_roles(self) -> None:
        """Warn about each role the selected chain declares that CLYOPS_FDS maps to a closed descriptor."""
        seen = set()
        for node in self._chain():
            for r in node._roles:
                name = str(r["name"])
                if name in seen:
                    continue
                seen.add(name)
                num = self._fd_mapping().get(name)
                if num is not None and self._mapped_fd(name) is None:
                    warn(f"CLYOPS_FDS maps '{name}' to {num}, but descriptor {num} isn't open")

    def fd_open(self, name: str) -> Optional[int]:
        """The descriptor for a declared role when CLYOPS_FDS maps it and it is open, else None
        (spec section 14)."""
        return self._mapped_fd(name) if self._find_role(name) is not None else None

    def emit(self, name: str, value: object) -> None:
        """Write a line to a declared "out" role (spec section 14): a string as is, anything else as
        compact JSON, then a newline. Does nothing when the runner didn't map it."""
        decl = self._find_role(name)
        if decl is None:
            raise ValueError(f"Unknown role '{name}'")
        if decl["direction"] != "out":
            raise ValueError(f"Role '{name}' is not an output")
        num = self._mapped_fd(name)
        if num is None:
            return
        text = value if isinstance(value, str) else json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        if not text.endswith("\n"):
            text += "\n"
        data = text.encode("utf-8")
        try:
            while data:
                data = data[os.write(num, data):]
        except OSError:
            pass  # The reader went away; a role is optional, so the program carries on.

    def forward_fds(self, *names: str) -> str:
        """The CLYOPS_FDS value passing these roles on to a program this one starts (spec section 14)."""
        out = []
        for name in names:
            num = self._mapped_fd(name)
            if num is not None:
                out.append(f"{name}:{num}")
        return ",".join(out)

    def exclusive(self, *longs: str) -> "Cli":
        """At most one of these options may be given."""
        return self._constraint("exclusive", longs)

    def requires(self, long: str, *longs: str) -> "Cli":
        """When the first option is given, the others must be too."""
        return self._constraint("requires", (long,) + longs)

    def one_of(self, *longs: str) -> "Cli":
        """At least one of these options must be given."""
        return self._constraint("oneOf", longs)

    def _constraint(self, kind: str, longs: Sequence[str]) -> "Cli":
        for long in longs:
            if not self._find(long, False):
                raise ValueError(f"Unknown option --{long} in constraint")
        self._constraints.append({"type": kind, "options": list(longs)})
        return self

    def command(self, name: str, description: str = "") -> "Cli":
        """Register a command (spec section 1.7) and return it, to register its options and arguments on."""
        if self._args:
            raise ValueError("Cannot mix commands and positional arguments")
        if any(c._word == name for c in self._children):
            raise ValueError(f"Duplicate command {name}")
        child = Cli(f"{self.name} {name}", self.root, self.cwd, self.env)
        child.description = description
        child._parent = self
        child._word = name
        self._children.append(child)
        return child

    @property
    def command_path(self) -> List[str]:
        """The command words selected by the last parse, e.g. ["db", "migrate"]."""
        words: List[str] = []
        node: Optional[Cli] = self._selected
        while node is not None and node is not self:
            words.insert(0, node._word)
            node = node._parent
        return words

    def _chain(self) -> List["Cli"]:
        """The selected command, its parent, ... up to this one."""
        out: List[Cli] = []
        node: Optional[Cli] = self._selected
        while node is not None:
            out.append(node)
            node = None if node is self else node._parent
        return out

    def _chain_options(self) -> List[_Option]:
        return [o for n in self._chain() for o in n._options]

    def _find(self, name: str, short: bool) -> Optional[_Option]:
        """An option by long (or short) name, in this level and its ancestors."""
        node: Optional[Cli] = self
        while node is not None:
            opt = (node._by_short if short else node._by_long).get(name)
            if opt:
                return opt
            node = node._parent
        return None

    def set_config(self, option: str, prefixes: str) -> "Cli":
        """`option` holds the config file path; `prefixes` is comma-separated."""
        self._config_option = option
        self._config_prefixes = [p.strip() for p in prefixes.split(",") if p.strip()]
        return self

    def require_command(self, command: str, description: str, install_hint: str = "") -> "Cli":
        """Require an executable on PATH when parsing; description and install_hint explain how to install it."""
        self._commands.append((command, description, install_hint))
        return self

    def set_path_search(self, long: str, dirs: Union[str, Sequence[str]]) -> "Cli":
        """Fallback dirs (relative to root) for bare relative values of a path option."""
        opt = self._by_long[long]
        items = dirs.split(":") if isinstance(dirs, str) else list(dirs)
        opt.search_dirs = [os.path.normpath(os.path.join(self.root, d)) for d in items if d]
        if not opt.rule:
            opt.rule = "path"
        return self

    def opt(self, var: str, long: str, short: str = "", default: str = "", description: str = "",
            group: str = "Options", rule: str = "") -> "Cli":
        """Register an option. `default` is a value, "flag", "optional", or "" (required)."""
        kind = "flag" if default == "flag" else "value"
        value = "" if default in ("flag", "optional") else default
        return self._add(_Option(var, long, short, kind, value, default == "", description, group, rule))

    def opt_array(self, var: str, long: str, short: str = "", description: str = "",
                  group: str = "Options", rule: str = "") -> "Cli":
        """Register a repeatable option whose values accumulate into a list."""
        return self._add(_Option(var, long, short, "array", "", False, description, group, rule))

    def arg(self, name: str, description: str = "", default: str = "", rule: str = "") -> "Cli":
        """Register a positional argument. An empty default makes it required."""
        return self._add_arg(_Arg(name, description, default, rule, False))

    def arg_variadic(self, name: str, description: str = "", rule: str = "") -> "Cli":
        """Register a final positional argument that collects all remaining tokens."""
        return self._add_arg(_Arg(name, description, "", rule, True))

    def _add(self, opt: _Option) -> "Cli":
        if opt.long in self._by_long:
            raise ValueError(f"Duplicate option --{opt.long}")
        if opt.short and (len(opt.short) != 1 or opt.short in self._by_short):
            raise ValueError(f"Invalid or duplicate short option -{opt.short}")
        if opt.rule == "secret" or opt.rule.startswith("secret:"):
            opt.secret, opt.rule = True, opt.rule[7:]
        if not _known_rule(opt.rule):
            raise ValueError(f"Unknown validation rule '{opt.rule}' for --{opt.long}")
        self._options.append(opt)
        self._by_long[opt.long] = opt
        if opt.short:
            self._by_short[opt.short] = opt
        return self

    def _add_arg(self, arg: _Arg) -> "Cli":
        if self._children:
            raise ValueError("Cannot mix commands and positional arguments")
        if any(a.variadic for a in self._args):
            raise ValueError(f"Argument {arg.name} registered after a variadic argument")
        if not _known_rule(arg.rule):
            raise ValueError(f"Unknown validation rule '{arg.rule}' for {arg.name}")
        self._args.append(arg)
        return self

    def _ensure_help(self) -> None:
        if "help" not in self._by_long:
            short = "" if "h" in self._by_short else "h"
            self._add(_Option("HELP", "help", short, "flag", "", False, "Show this help message and exit", "Global", ""))

    # -- parsing --------------------------------------------------------------

    def parse(self, argv: Optional[Sequence[str]] = None) -> ParseResult:
        """Parse without exiting. Values are in `self.values` when status is "ok"."""
        argv = list(sys.argv[1:] if argv is None else argv)
        self._raw, self._arg_raw, self._sources, self._config = {}, {}, {}, {}
        self.values = Values()
        self._selected = self
        self._fd_mapping()
        self._ensure_help()

        try:
            self._scan(argv)
            scan_error = None
        except _ParseError as exc:
            scan_error = str(exc)
        if scan_error is None and self._config_option:
            try:
                self._load_config()
            except _ParseError as exc:
                scan_error = str(exc)
        if self._raw.get("help") == "true":
            return ParseResult("help")
        if scan_error is not None:
            return ParseResult("error", scan_error)

        try:
            self._resolve()
        except (_ParseError, ValidationError) as exc:
            return ParseResult("error", str(exc))

        missing_cmds = [c for n in reversed(self._chain()) for c in n._commands
                        if not shutil.which(c[0], path=self.env.get("PATH", ""))]
        if missing_cmds:
            detail = []
            for cmd, desc, hint in missing_cmds:
                detail.append(f"  {cmd} - {desc}")
                if hint:
                    detail.append(f"    Install: {hint}")
            return ParseResult("error", "Missing required command(s): " + ", ".join(c[0] for c in missing_cmds),
                               False, detail)

        missing = [f"--{o.long}" for o in self._chain_options() if o.required and not self._raw.get(o.long)]
        if missing:
            return ParseResult("error", "Missing required argument(s): " + " ".join(missing))
        conflict = self._check_constraints()
        if conflict:
            return ParseResult("error", conflict)
        self._warn_unopened_roles()
        return ParseResult("ok")

    def _check_constraints(self) -> Optional[str]:
        """Spec section 1.6: the first relationship that fails, from the program down."""
        def given(long: str) -> bool:
            opt = self._selected._find(long, False)
            v = self.values.get(opt.var) if opt else None
            return self.source(long) in ("cli", "config", "env") and v is not False and v != []

        for node in reversed(self._chain()):
            for c in node._constraints:
                longs: List[str] = c["options"]  # type: ignore[assignment]
                on = [o for o in longs if given(o)]
                if c["type"] == "exclusive" and len(on) > 1:
                    return f"Options --{on[0]} and --{on[1]} cannot be used together"
                if c["type"] == "requires" and given(longs[0]):
                    absent = next((o for o in longs[1:] if not given(o)), None)
                    if absent:
                        return f"Option --{longs[0]} requires --{absent}"
                if c["type"] == "oneOf" and not on:
                    return "One of " + ", ".join(f"--{o}" for o in longs) + " is required"
        return None

    def _set_cli(self, opt: _Option, value: str) -> None:
        if opt.kind == "array":
            current = self._raw[opt.long] if self._sources.get(opt.long) == "cli" else []
            self._raw[opt.long] = list(current) + [value]
        else:
            self._raw[opt.long] = value
        self._sources[opt.long] = "cli"

    def _scan(self, argv: List[str]) -> None:
        pos = 0
        rest: Optional[List[str]] = None
        end_of_options = False
        i = 0
        while i < len(argv):
            token = argv[i]
            i += 1
            if end_of_options or token == "-" or not token.startswith("-"):
                node = self._selected
                if rest is not None:
                    rest.append(token)
                elif node._children:
                    child = next((c for c in node._children if c._word == token), None)
                    if child is None:
                        raise _ParseError(f"Unknown command: {token}")
                    self._selected = child
                elif pos >= len(node._args):
                    raise _ParseError(f"Unexpected argument: {token}")
                else:
                    arg = node._args[pos]
                    pos += 1
                    if arg.variadic:
                        rest = [token]
                        self._arg_raw[arg.name] = rest
                    else:
                        self._arg_raw[arg.name] = token
            elif token == "--":
                end_of_options = True
            elif token.startswith("--"):
                name, eq, value = token[2:].partition("=")
                opt = self._selected._find(name, False)
                if opt and eq:
                    if opt.kind == "flag":
                        b = _bool_word(value)
                        if b is None:
                            raise _ParseError(f"Option --{name} expects a boolean value, got '{value}'")
                        value = "true" if b else "false"
                    self._set_cli(opt, value)
                elif opt:
                    if opt.kind == "flag":
                        self._set_cli(opt, "true")
                    else:
                        if i >= len(argv) or argv[i].startswith("--"):
                            raise _ParseError(f"Option --{name} requires an argument")
                        self._set_cli(opt, argv[i])
                        i += 1
                elif name.startswith("no-") and not eq and self._selected._find(name[3:], False):
                    target = self._selected._find(name[3:], False)
                    assert target is not None
                    if not target.bool_like:
                        raise _ParseError(f"Option --{name} can only be used with flag/boolean options")
                    self._set_cli(target, "false")
                else:
                    raise _ParseError(f"Unknown option: --{name}")
            else:
                cluster = token[1:]
                for j, ch in enumerate(cluster):
                    opt = self._selected._find(ch, True)
                    if not opt:
                        raise _ParseError(f"Unknown option: -{ch}")
                    if opt.kind == "flag":
                        self._set_cli(opt, "true")
                        continue
                    if j + 1 < len(cluster):
                        self._set_cli(opt, cluster[j + 1:])
                        break
                    if i >= len(argv) or argv[i].startswith("-"):
                        raise _ParseError(f"Option -{ch} requires an argument")
                    self._set_cli(opt, argv[i])
                    i += 1
                    break

    def _load_config(self) -> None:
        opt = self._selected._find(self._config_option, False)
        if not opt:
            return
        path, source = self._raw.get(opt.long), "cli"
        assert not isinstance(path, list)
        if path is None and self.env.get(opt.var):
            path, source = self.env[opt.var], "env"
        if path is None and opt.default:
            path, source = opt.default, "default"
        if not path or path == "disabled":
            return
        resolved = resolve_path(path, self.cwd, opt.search_dirs)
        self._raw[opt.long] = resolved
        self._sources[opt.long] = source
        self._read_config(resolved, 0, set())

        for key, (value, _) in self._config.items():
            target = self._selected._find(key, False)
            if not target or target is opt or self._sources.get(key) == "cli":
                continue
            if target.kind == "flag":
                b = _bool_word(value)
                if b is None:
                    raise _ParseError(f"Config value for --{key} must be a boolean, got '{value}'")
                self._raw[key] = "true" if b else "false"
            else:
                self._raw[key] = [value] if target.kind == "array" else value
            self._sources[key] = "config"

    def _read_config(self, path: str, depth: int, stack: set) -> None:
        if depth > 10:
            raise _ParseError(f"Config include depth exceeded (10) while processing: {path}")
        if not os.path.isfile(path):
            raise _ParseError(f"Config file not found: {path}")
        if path in stack:
            raise _ParseError(f"Circular config include detected: {path}")
        stack.add(path)
        directory = os.path.dirname(path)
        with open(path, encoding="utf-8", newline="") as fh:
            lines = fh.read().split("\n")
        for line in lines:
            line = line[:-1] if line.endswith("\r") else line
            trimmed = line.strip()
            if not trimmed or trimmed.startswith("#"):
                continue
            include = re.match(r"\s*@include\s+(.+)$", line)
            if include:
                target = include.group(1).strip()
                quoted = re.fullmatch(r"(['\"])(.*)\1", target)
                if quoted:
                    target = quoted.group(2)
                self._read_config(os.path.normpath(os.path.join(directory, target)), depth + 1, stack)
                continue
            if self._config_prefixes:
                prefix = next((p for p in self._config_prefixes if line.startswith(p)), None)
                if prefix is None:
                    continue
                body = line[len(prefix):]
            else:
                body = line
            key, eq, value = body.partition("=")
            key = key.strip()
            if key.startswith("--"):
                key = key[2:]
            if not eq or not key:
                continue
            self._config[key] = (value.strip(), directory)
        stack.discard(path)

    def _resolve(self) -> None:
        if self._selected._children:
            raise _ParseError("Missing command")
        options = self._chain_options()
        args = self._selected._args
        for arg in args:
            if arg.name in self._arg_raw:
                continue
            if arg.variadic:
                self._arg_raw[arg.name] = []
            elif not arg.default:
                raise _ParseError(f"Missing required positional argument: {arg.name}")
            else:
                self._arg_raw[arg.name] = arg.default

        for opt in options:
            if opt.long in self._sources:
                continue
            env_value = None if opt.kind == "array" else self.env.get(opt.var)
            if env_value:
                if opt.kind == "flag":
                    b = _bool_word(env_value)
                    if b is None:
                        raise _ParseError(f"Environment variable {opt.var} must be a boolean, got '{env_value}'")
                    env_value = "true" if b else "false"
                self._raw[opt.long] = env_value
                self._sources[opt.long] = "env"
            elif opt.kind == "flag":
                self._raw[opt.long] = "false"
                self._sources[opt.long] = "default"
            elif opt.default:
                self._raw[opt.long] = opt.default
                self._sources[opt.long] = "default"

        # Path resolution: the base depends on where the value came from.
        for opt in options:
            if not _is_path_rule(opt.rule) or opt.long not in self._raw or opt.long == self._config_option:
                continue
            source = self._sources[opt.long]
            base = self.cwd if source == "cli" else self._config[opt.long][1] if source == "config" else self.root
            value = self._raw[opt.long]

            def one(v: str, rule: str = opt.rule, base: str = base, dirs: Sequence[str] = opt.search_dirs) -> str:
                # A bare program name stays as given (spec section 6).
                return v if rule == "file:executable" and is_bare_program(v) else resolve_path(v, base, dirs)
            self._raw[opt.long] = [one(v) for v in value] if isinstance(value, list) else one(value)
        for arg in args:
            if _is_path_rule(arg.rule):
                value = self._arg_raw[arg.name]

                def one_arg(v: str, rule: str = arg.rule) -> str:
                    return v if rule == "file:executable" and is_bare_program(v) else resolve_path(v, self.cwd)
                self._arg_raw[arg.name] = [one_arg(v) for v in value] if isinstance(value, list) else one_arg(value)

        def convert(v: str, rule: str, name: str) -> Scalar:
            return validate(v, rule, name) if v and rule else v

        for opt in options:
            raw = self._raw.get(opt.long)
            if raw is None:
                self.values[opt.var] = [] if opt.kind == "array" else None
            elif opt.kind == "flag":
                self.values[opt.var] = raw == "true"
            elif isinstance(raw, list):
                self.values[opt.var] = [convert(v, opt.rule, f"--{opt.long}") for v in raw]
            else:
                self.values[opt.var] = convert(raw, opt.rule, f"--{opt.long}")
        for arg in args:
            value = self._arg_raw[arg.name]
            if isinstance(value, list):
                self.values[arg.name] = [convert(v, arg.rule, arg.name) for v in value]
            else:
                self.values[arg.name] = convert(value, arg.rule, arg.name)
        if self._children:
            self.values["command"] = self.command_path  # type: ignore[assignment]

    def run(self, argv: Optional[Sequence[str]] = None) -> Values:
        """Parse like a CLI: handles --help, --help-json-schema and --bash-completion,
        prints errors and exits on failure. Returns the values."""
        argv = list(sys.argv[1:] if argv is None else argv)
        head = argv[:argv.index("--")] if "--" in argv else argv
        if "--help-json-schema" in head:
            sys.stdout.write(self.json_schema() + "\n")
            sys.exit(0)
        if "--bash-completion" in head:
            sys.stdout.write(self.completion_data(argv[argv.index("--") + 1:] if "--" in argv else []))
            sys.exit(0)
        if "--completion" in head:
            shell = head[head.index("--completion") + 1] if head.index("--completion") + 1 < len(head) else ""
            script = self.completion_script(shell)
            if script is None:
                die(1, f"Unknown shell '{shell}' (expected bash, zsh or fish)")
            sys.stdout.write(script)
            sys.exit(0)

        result = self.parse(argv)
        if result.status == "help":
            sys.stdout.write(self.usage())
            sys.exit(0)
        if result.status == "error":
            _emit("error", result.error, force=True)
            for line in result.detail:
                sys.stderr.write(line + "\n")
            if result.show_usage:
                sys.stderr.write(self.usage())
            sys.exit(1)
        return self.values

    # -- accessors ------------------------------------------------------------

    def get(self, name: str) -> Value:
        """Return the resolved value for a variable or argument name, or None when absent."""
        return self.values.get(name)

    def source(self, long: str) -> str:
        """Where an option's value came from: cli, config, env, default or unset."""
        return self._sources.get(long[2:] if long.startswith("--") else long, "unset")

    def is_set(self, long: str) -> bool:
        """Return whether the option was supplied on the command line (long name, optionally prefixed with --)."""
        return self.source(long) == "cli"

    def is_explicitly_set(self, long: str) -> bool:
        """Return whether the option came from CLI, config, or environment rather than a default."""
        return self.source(long) in ("cli", "config", "env")

    def values_json(self) -> str:
        """Resolved values as JSON (spec section 10)."""
        out: Dict[str, object] = {}
        for o in self._chain_options():
            v = self.values.get(o.var)
            out[o.var] = (["***"] * len(v) if isinstance(v, list) else "***") if o.secret and v is not None else v
        out.update({a.name: self.values.get(a.name) for a in self._selected._args})
        if self._children:
            out["command"] = self.command_path
        return json.dumps(out, indent=2, ensure_ascii=False)

    # -- output ---------------------------------------------------------------

    def usage(self) -> str:
        """Help text (spec section 7), for the selected command."""
        self._ensure_help()
        node = self._selected
        chain = self._chain()
        options = self._chain_options()
        width = self.env.get("CLYOPS_MAX_WIDTH", "")
        max_width = int(width) if width.isdigit() and int(width) > 0 else 100
        longest = max([len(o.label) for o in options] + [len(c._word) for c in node._children], default=0)
        indent = min(50, max(32, longest + 4))
        text_width = max(20, max_width - indent)

        def row(label: str, text: str) -> List[str]:
            left = "  " + label
            left = left.ljust(indent) if len(left) < indent else left + " "
            lines = wrap_text(text, text_width)
            return [left + lines[0]] + [" " * indent + line for line in lines[1:]]

        def annotate(text: str, notes: List[str]) -> str:
            return f"{text} ({', '.join(notes)})" if notes else text

        sections: List[List[str]] = []
        usage = f"Usage: {node.name}"
        if node._children:
            usage += " <command>"
        for arg in node._args:
            usage += f" [<{arg.name}...>]" if arg.variadic else f" [<{arg.name}>]" if arg.default else f" <{arg.name}>"
        sections.append([usage + " [OPTIONS]"])

        if node.description:
            sections.append(wrap_text(node.description, max_width))

        io = []
        for label, decl in (("Input:", node._stdin), ("Output:", node._stdout)):
            if decl is not None:
                ctype = decl["contentType"]
                io.append(" ".join(x for x in (label, decl["description"], ctype and f"({ctype})") if x))
        for r in node._roles:
            label = f"{'Input' if r['direction'] == 'in' else 'Output'} [{r['name']}]:"
            ctype = str(r["contentType"])
            io.append(" ".join(x for x in (label, str(r["description"]), ctype and f"({ctype})") if x))
        if io:
            sections.append(io)

        if node._children:
            sections.append(["Commands:"] + [line for c in node._children for line in row(c._word, c.description)])

        if node._args:
            lines = ["Positional Arguments:"]
            for arg in node._args:
                notes = (["variadic"] if arg.variadic else []) + ([f"default: {arg.default}"] if arg.default else [])
                if arg.rule:
                    notes.append(f"accepts: {describe_rule(arg.rule)}")
                lines += row(arg.name, annotate(arg.description, notes))
            sections.append(lines)

        commands = [c for n in reversed(chain) for c in n._commands]
        if commands:
            lines = ["Required Commands:"]
            for cmd, desc, hint in commands:
                status = "installed" if shutil.which(cmd, path=self.env.get("PATH", "")) else "not found"
                lines += row(f"{cmd} [{status}]", f"{desc} ({hint})" if hint else desc)
            sections.append(lines)

        constraints = [c for n in reversed(chain) for c in n._constraints]
        groups = list(dict.fromkeys(o.group for o in options))
        for group in groups:
            lines = [f"{group}:"]
            for opt in (o for o in options if o.group == group):
                notes = []
                if opt.required:
                    notes.append("required")
                if opt.kind == "array":
                    notes.append("multiple")
                if opt.secret:
                    notes.append("secret")
                if opt.long in self._config:
                    notes.append(f"config: {'***' if opt.secret else self._config[opt.long][0]}")
                if opt.default:
                    notes.append(f"default: {opt.default}")
                if opt.rule:
                    notes.append(f"accepts: {describe_rule(opt.rule)}")
                for c in constraints:
                    longs: List[str] = c["options"]  # type: ignore[assignment]
                    if opt.long not in longs:
                        continue
                    if c["type"] == "exclusive":
                        notes.append("conflicts with: " + ", ".join(f"--{o}" for o in longs if o != opt.long))
                    elif c["type"] == "requires" and longs[0] == opt.long:
                        notes.append("requires: " + ", ".join(f"--{o}" for o in longs[1:]))
                    elif c["type"] == "oneOf":
                        notes.append("one of: " + ", ".join(f"--{o}" for o in longs))
                lines += row(opt.label, annotate(opt.description, notes))
            sections.append(lines)

        if node.epilog:
            sections.append(node.epilog.rstrip("\n").split("\n"))

        text = "\n\n".join("\n".join(s) for s in sections)
        return "\n".join(line.rstrip() for line in text.split("\n")) + "\n"

    def json_schema(self) -> str:
        """JSON description of the CLI (spec section 8)."""
        self._ensure_help()
        return json.dumps({"clyops": 1, "script": self.name, **self._schema_node()}, indent=2, ensure_ascii=False)

    def _schema_node(self) -> Dict[str, object]:
        def type_of(o: _Option) -> str:
            r = o.rule
            if o.kind == "flag" or r == "bool":
                return "boolean"
            if r.startswith("int") or r == "port":
                return "integer"
            if r.startswith("float"):
                return "number"
            if r.startswith("choice:"):
                return "choice"
            return "path" if _is_path_rule(r) else "string"

        return {
            **({"name": self._word} if self._parent else {}),
            "description": self.description,
            "epilog": self.epilog,
            "arguments": [{
                "name": a.name, "description": a.description, "required": not a.variadic and not a.default,
                "isVariadic": a.variadic, "default": a.default, "validation": a.rule,
                "schema": _rule_schema(a.rule, self.root, a.name),
            } for a in self._args],
            "options": [{
                "name": o.long, "shortName": o.short, "variableName": o.var, "description": o.description,
                "default": "false" if o.kind == "flag" else o.default, "group": o.group, "type": type_of(o),
                "isFlag": o.kind == "flag", "isArray": o.kind == "array", "required": o.required,
                "validation": o.rule, "choices": o.rule[7:].split(",") if o.rule.startswith("choice:") else [],
                "schema": _rule_schema(o.rule, self.root, f"--{o.long}"), "secret": o.secret,
            } for o in self._options],
            **({} if self._parent else {"config": {"option": self._config_option, "prefixes": list(self._config_prefixes)}
                                        if self._config_option else None}),
            "requiredCommands": [{"command": c, "description": d, "installHint": h} for c, d, h in self._commands],
            "effects": self._effects,
            "constraints": self._constraints,
            "stdin": self._stdin,
            "stdout": self._stdout,
            "roles": [dict(r) for r in self._roles],
            "commands": [c._schema_node() for c in self._children],
        }

    def completion_script(self, shell: str) -> Optional[str]:
        """Shell script that enables completion for this program (spec section 9):
        eval "$(prog --completion bash)". None for an unknown shell."""
        template = _COMPLETION_SCRIPTS.get(shell)
        if template is None:
            return None
        func = re.sub(r"[^A-Za-z0-9_]", "_", self.name)
        return template.replace("__CLYOPS_FUNC__", func).replace("__CLYOPS_PROG__", self.name)

    def completion_data(self, words: Sequence[str] = ()) -> str:
        """Tab-separated completion records (spec section 9). `words` are the words typed
        after the program name; a program with commands follows them."""
        self._ensure_help()

        def clean(s: str) -> str:
            return s.replace("\t", " ").replace("\n", " ")

        lines = ["#clyops-completion 1"]
        node: Cli = self
        if self._children:
            skip = 0
            for w in words:
                child = next((c for c in node._children if c._word == w), None)
                if child is None:
                    break
                node, skip = child, skip + 1
            if node._children and skip < len(words) and not words[skip].startswith("-"):
                return lines[0] + "\n"
            lines.append(f"skip\t{skip}")
            lines += [f"cmd\t{c._word}\t{clean(c.description)}" for c in node._children]
        options: List[_Option] = []
        current: Optional[Cli] = node
        while current is not None:
            options += current._options
            current = current._parent
        for o in options:
            short = f"-{o.short}" if o.short else "-"
            if o.kind == "flag":
                lines.append(f"opt\t--{o.long}\t{short}\tflag\tnone\t-\t{clean(o.description)}")
            else:
                kind, values = _completion_kind(o.rule, o.search_dirs)
                lines.append(f"opt\t--{o.long}\t{short}\tvalue\t{kind}\t{values or '-'}\t{clean(o.description)}")
            if o.bool_like:
                lines.append(f"opt\t--no-{o.long}\t-\tflag\tnone\t-\t{clean(o.description)}")
        for a in node._args:
            kind, values = _completion_kind(a.rule, [])
            arity = "variadic" if a.variadic else "single"
            lines.append(f"arg\t{a.name}\t{arity}\t{kind}\t{values or '-'}\t{clean(a.description)}")
        return "\n".join(lines) + "\n"
