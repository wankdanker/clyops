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
from typing import Dict, List, NoReturn, Optional, Sequence, Union

from ._completions import SCRIPTS as _COMPLETION_SCRIPTS

__all__ = [
    "Cli", "Values", "ParseResult", "ValidationError", "validate", "resolve_path", "describe_rule", "wrap_text",
    "info", "warn", "error", "success", "die", "set_silent",
]
__version__ = "0.2.0"

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
    _emit("info", msg)


def warn(msg: str) -> None:
    _emit("warning", msg)


def error(msg: str) -> None:
    _emit("error", msg)


def success(msg: str) -> None:
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
    "int", "float", "string", "path", "ip", "hostname", "url", "port", "email", "uuid", "bool",
    "date:YYYY-MM-DD", "file:exists", "file:readable", "file:writable", "dir:exists", "dir:writable",
}
_HOSTNAME = r"[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*"


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
    return False


def _bounds(rule: str):
    rng = rule.split(":", 1)[1]
    lo, _, hi = rng.partition("-")
    return lo, hi


def _is_path_rule(rule: str) -> bool:
    return rule == "path" or rule.startswith(("file:", "dir:"))


def describe_rule(rule: str) -> str:
    """Help text for a validation rule (spec section 5)."""
    fixed = {
        "int": "integer", "float": "number", "string": "text", "path": "path", "ip": "IP address",
        "hostname": "hostname", "url": "URL", "port": "port: 1-65535", "email": "email address", "uuid": "UUID",
        "bool": "true/false, yes/no, 1/0, on/off", "date:YYYY-MM-DD": "date: YYYY-MM-DD",
        "file:exists": "existing file", "file:readable": "readable file", "file:writable": "writable file",
        "dir:exists": "existing directory", "dir:writable": "writable directory",
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
    return rule


class ValidationError(ValueError):
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
    status: str  # ok | help | error
    error: str = ""
    show_usage: bool = True
    detail: List[str] = field(default_factory=list)


class Values(dict):
    """Resolved values; keys are option vars and argument names, also readable as attributes."""

    def __getattr__(self, name: str) -> Value:
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None


class _ParseError(Exception):
    pass


class Cli:
    def __init__(self, name: Optional[str] = None, root: Optional[str] = None, cwd: Optional[str] = None,
                 env: Optional[Dict[str, str]] = None):
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

    # -- registration ---------------------------------------------------------

    def set_description(self, text: str) -> "Cli":
        self.description = text
        return self

    def set_epilog(self, text: str) -> "Cli":
        self.epilog = text
        return self

    def set_config(self, option: str, prefixes: str) -> "Cli":
        """`option` holds the config file path; `prefixes` is comma-separated."""
        self._config_option = option
        self._config_prefixes = [p.strip() for p in prefixes.split(",") if p.strip()]
        return self

    def require_command(self, command: str, description: str, install_hint: str = "") -> "Cli":
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
        if not _known_rule(opt.rule):
            raise ValueError(f"Unknown validation rule '{opt.rule}' for --{opt.long}")
        self._options.append(opt)
        self._by_long[opt.long] = opt
        if opt.short:
            self._by_short[opt.short] = opt
        return self

    def _add_arg(self, arg: _Arg) -> "Cli":
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

        missing_cmds = [c for c in self._commands if not shutil.which(c[0], path=self.env.get("PATH", ""))]
        if missing_cmds:
            detail = []
            for cmd, desc, hint in missing_cmds:
                detail.append(f"  {cmd} - {desc}")
                if hint:
                    detail.append(f"    Install: {hint}")
            return ParseResult("error", "Missing required command(s): " + ", ".join(c[0] for c in missing_cmds),
                               False, detail)

        missing = [f"--{o.long}" for o in self._options if o.required and not self._raw.get(o.long)]
        if missing:
            return ParseResult("error", "Missing required argument(s): " + " ".join(missing))
        return ParseResult("ok")

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
                if rest is not None:
                    rest.append(token)
                elif pos >= len(self._args):
                    raise _ParseError(f"Unexpected argument: {token}")
                else:
                    arg = self._args[pos]
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
                opt = self._by_long.get(name)
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
                elif name.startswith("no-") and not eq and name[3:] in self._by_long:
                    target = self._by_long[name[3:]]
                    if not target.bool_like:
                        raise _ParseError(f"Option --{name} can only be used with flag/boolean options")
                    self._set_cli(target, "false")
                else:
                    raise _ParseError(f"Unknown option: --{name}")
            else:
                cluster = token[1:]
                for j, ch in enumerate(cluster):
                    opt = self._by_short.get(ch)
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
        opt = self._by_long.get(self._config_option)
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
            target = self._by_long.get(key)
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
        for arg in self._args:
            if arg.name in self._arg_raw:
                continue
            if arg.variadic:
                self._arg_raw[arg.name] = []
            elif not arg.default:
                raise _ParseError(f"Missing required positional argument: {arg.name}")
            else:
                self._arg_raw[arg.name] = arg.default

        for opt in self._options:
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
        for opt in self._options:
            if not _is_path_rule(opt.rule) or opt.long not in self._raw or opt.long == self._config_option:
                continue
            source = self._sources[opt.long]
            base = self.cwd if source == "cli" else self._config[opt.long][1] if source == "config" else self.root
            value = self._raw[opt.long]
            if isinstance(value, list):
                self._raw[opt.long] = [resolve_path(v, base, opt.search_dirs) for v in value]
            else:
                self._raw[opt.long] = resolve_path(value, base, opt.search_dirs)
        for arg in self._args:
            if _is_path_rule(arg.rule):
                value = self._arg_raw[arg.name]
                if isinstance(value, list):
                    self._arg_raw[arg.name] = [resolve_path(v, self.cwd) for v in value]
                else:
                    self._arg_raw[arg.name] = resolve_path(value, self.cwd)

        def convert(v: str, rule: str, name: str) -> Scalar:
            return validate(v, rule, name) if v and rule else v

        for opt in self._options:
            raw = self._raw.get(opt.long)
            if raw is None:
                self.values[opt.var] = [] if opt.kind == "array" else None
            elif opt.kind == "flag":
                self.values[opt.var] = raw == "true"
            elif isinstance(raw, list):
                self.values[opt.var] = [convert(v, opt.rule, f"--{opt.long}") for v in raw]
            else:
                self.values[opt.var] = convert(raw, opt.rule, f"--{opt.long}")
        for arg in self._args:
            value = self._arg_raw[arg.name]
            if isinstance(value, list):
                self.values[arg.name] = [convert(v, arg.rule, arg.name) for v in value]
            else:
                self.values[arg.name] = convert(value, arg.rule, arg.name)

    def run(self, argv: Optional[Sequence[str]] = None) -> Values:
        """Parse like a CLI: handles --help, --help-json-schema and --bash-completion,
        prints errors and exits on failure. Returns the values."""
        argv = list(sys.argv[1:] if argv is None else argv)
        head = argv[:argv.index("--")] if "--" in argv else argv
        if "--help-json-schema" in head:
            sys.stdout.write(self.json_schema() + "\n")
            sys.exit(0)
        if "--bash-completion" in head:
            sys.stdout.write(self.completion_data())
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
        return self.values.get(name)

    def source(self, long: str) -> str:
        """Where an option's value came from: cli, config, env, default or unset."""
        return self._sources.get(long[2:] if long.startswith("--") else long, "unset")

    def is_set(self, long: str) -> bool:
        return self.source(long) == "cli"

    def is_explicitly_set(self, long: str) -> bool:
        return self.source(long) in ("cli", "config", "env")

    def values_json(self) -> str:
        """Resolved values as JSON (spec section 10)."""
        out = {o.var: self.values.get(o.var) for o in self._options}
        out.update({a.name: self.values.get(a.name) for a in self._args})
        return json.dumps(out, indent=2, ensure_ascii=False)

    # -- output ---------------------------------------------------------------

    def usage(self) -> str:
        """Help text (spec section 7)."""
        self._ensure_help()
        width = self.env.get("CLYOPS_MAX_WIDTH", "")
        max_width = int(width) if width.isdigit() and int(width) > 0 else 100
        longest = max((len(o.label) for o in self._options), default=0)
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
        usage = f"Usage: {self.name}"
        for arg in self._args:
            usage += f" [<{arg.name}...>]" if arg.variadic else f" [<{arg.name}>]" if arg.default else f" <{arg.name}>"
        sections.append([usage + " [OPTIONS]"])

        if self.description:
            sections.append(wrap_text(self.description, max_width))

        if self._args:
            lines = ["Positional Arguments:"]
            for arg in self._args:
                notes = (["variadic"] if arg.variadic else []) + ([f"default: {arg.default}"] if arg.default else [])
                if arg.rule:
                    notes.append(f"accepts: {describe_rule(arg.rule)}")
                lines += row(arg.name, annotate(arg.description, notes))
            sections.append(lines)

        if self._commands:
            lines = ["Required Commands:"]
            for cmd, desc, hint in self._commands:
                status = "installed" if shutil.which(cmd, path=self.env.get("PATH", "")) else "not found"
                lines += row(f"{cmd} [{status}]", f"{desc} ({hint})" if hint else desc)
            sections.append(lines)

        groups = list(dict.fromkeys(o.group for o in self._options))
        for group in groups:
            lines = [f"{group}:"]
            for opt in (o for o in self._options if o.group == group):
                notes = []
                if opt.required:
                    notes.append("required")
                if opt.kind == "array":
                    notes.append("multiple")
                if opt.long in self._config:
                    notes.append(f"config: {self._config[opt.long][0]}")
                if opt.default:
                    notes.append(f"default: {opt.default}")
                if opt.rule:
                    notes.append(f"accepts: {describe_rule(opt.rule)}")
                lines += row(opt.label, annotate(opt.description, notes))
            sections.append(lines)

        if self.epilog:
            sections.append(self.epilog.rstrip("\n").split("\n"))

        text = "\n\n".join("\n".join(s) for s in sections)
        return "\n".join(line.rstrip() for line in text.split("\n")) + "\n"

    def json_schema(self) -> str:
        """JSON description of the CLI (spec section 8)."""
        self._ensure_help()

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

        return json.dumps({
            "clyops": 1,
            "script": self.name,
            "description": self.description,
            "epilog": self.epilog,
            "arguments": [{
                "name": a.name, "description": a.description, "required": not a.variadic and not a.default,
                "isVariadic": a.variadic, "default": a.default, "validation": a.rule,
            } for a in self._args],
            "options": [{
                "name": o.long, "shortName": o.short, "variableName": o.var, "description": o.description,
                "default": "false" if o.kind == "flag" else o.default, "group": o.group, "type": type_of(o),
                "isFlag": o.kind == "flag", "isArray": o.kind == "array", "required": o.required,
                "validation": o.rule, "choices": o.rule[7:].split(",") if o.rule.startswith("choice:") else [],
            } for o in self._options],
            "requiredCommands": [{"command": c, "description": d, "installHint": h} for c, d, h in self._commands],
        }, indent=2, ensure_ascii=False)

    def completion_script(self, shell: str) -> Optional[str]:
        """Shell script that enables completion for this program (spec section 9):
        eval "$(prog --completion bash)". None for an unknown shell."""
        template = _COMPLETION_SCRIPTS.get(shell)
        if template is None:
            return None
        func = re.sub(r"[^A-Za-z0-9_]", "_", self.name)
        return template.replace("__CLYOPS_FUNC__", func).replace("__CLYOPS_PROG__", self.name)

    def completion_data(self) -> str:
        """Tab-separated completion records (spec section 9)."""
        self._ensure_help()

        def clean(s: str) -> str:
            return s.replace("\t", " ").replace("\n", " ")

        lines = ["#clyops-completion 1"]
        for o in self._options:
            short = f"-{o.short}" if o.short else "-"
            if o.kind == "flag":
                lines.append(f"opt\t--{o.long}\t{short}\tflag\tnone\t-\t{clean(o.description)}")
            else:
                kind, values = _completion_kind(o.rule, o.search_dirs)
                lines.append(f"opt\t--{o.long}\t{short}\tvalue\t{kind}\t{values or '-'}\t{clean(o.description)}")
            if o.bool_like:
                lines.append(f"opt\t--no-{o.long}\t-\tflag\tnone\t-\t{clean(o.description)}")
        for a in self._args:
            kind, values = _completion_kind(a.rule, [])
            arity = "variadic" if a.variadic else "single"
            lines.append(f"arg\t{a.name}\t{arity}\t{kind}\t{values or '-'}\t{clean(a.description)}")
        return "\n".join(lines) + "\n"
