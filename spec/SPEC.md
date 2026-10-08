# clyops specification (v1)

This document is the contract every clyops implementation follows. The shared
conformance suite (`spec/conformance/`) checks it byte-for-byte for help text
and completion data, and semantically for JSON output and resolved values.

Language packages keep their own idioms for *how* things are registered, but
the *behavior* below is identical everywhere.

## 0. Registration style

The head of a program is its interface, so registration must stay **one line
per option or argument** in every language: a single call carrying the
variable, names, default, description, group and rule. Multi-line builders or
one-struct-per-option boilerplate defeat the purpose. Each package's README
shows the same demo CLI so the styles can be compared side by side:

```sh
clyops_opt PORT port p 8080 "Server port" Network port                       # Bash
cli.opt('PORT', 'port', 'p', '8080', 'Server port', 'Network', 'port');    // JS / TS
cli.opt("PORT", "port", "p", "8080", "Server port", group="Network", rule="port")  # Python
cli.opt("PORT", "port", "p", "8080", "Server port").group("Network").rule("port"); // Rust
clyops_opt(cli, "PORT", "port", "8080", .short_name = 'p', .description = "Server port", .group = "Network", .rule = "port"); // C
```

C uses a compound-literal macro (`__VA_ARGS__` designated initializers) so
optional fields are named inline; Python uses keyword arguments; Rust chains
optional setters on the same line.

## 1. Model

A CLI is a list of **options**, a list of **positional arguments**, and some
metadata.

### 1.1 Options

| Field | Meaning |
| --- | --- |
| `var` | Variable name. Key in resolved values; also the environment variable consulted for the option. |
| `long` | Long name without `--`. Unique. |
| `short` | Optional single character without `-`. |
| `default` | See below. |
| `description` | Help text. |
| `group` | Help section. Default `Options`. |
| `validation` | Optional validation rule (section 5). |

The `default` field has three special values:

| `default` | Meaning |
| --- | --- |
| `flag` | Boolean flag. Takes no value. Resolves to `true`/`false`, `false` when unset. |
| `optional` | Not required, no default. Resolves to *unset* (`null`) when not given. |
| `""` (empty) | **Required.** Missing after resolution is an error. |
| anything else | Default value (a string, converted like any other value). |

An **array option** is registered separately (`var`, `long`, `short`,
`description`, `group`, `validation`). Every occurrence appends a value. It is
never required and resolves to an empty list when not given.

### 1.2 Positional arguments

| Field | Meaning |
| --- | --- |
| `name` | Name; also its key in resolved values. |
| `description` | Help text. |
| `default` | `""` means required. |
| `validation` | Optional validation rule. |

A **variadic** argument (`name`, `description`, `validation`) collects every
remaining positional token. It must be registered last, is never required and
resolves to a list.

### 1.3 Metadata

* `description`, `epilog`: help text before the arguments / after the options.
* `config(option, prefixes)`: the named option holds a config file path;
  `prefixes` is a comma-separated list of line prefixes (section 4).
* `requireCommand(command, description, installHint)`: an external program
  that must be on `PATH`.
* `pathSearch(long, dirs)`: fallback directories for bare relative values of a
  path option (section 6). Tags the option with the `path` rule if it has no rule.
* `root`: base directory for default/env path values and relative search dirs.
  Defaults to the current working directory.
* `name`: program name shown in usage. Defaults to the basename of `argv[0]`.

Registering an unknown validation rule, a duplicate long/short name, or a
positional argument after a variadic is a programming error, reported at
registration time in the language's usual way (exception, panic, or a message
and exit status 2 in Bash and C), e.g. `Unknown validation rule 'R' for --NAME`.

### 1.4 Built-in help option

When parsing starts, if no option named `help` exists, implementations register
`var=HELP long=help short=h default=flag group=Global description="Show this
help message and exit"`. The short `-h` is omitted if another option already
uses `h`. It is registered last, so `Global` is the last group unless the user
also used it.

## 2. Command-line scanning

Tokens are processed left to right. Scanning stops at the first error.

| Token | Behavior |
| --- | --- |
| `--` | Every later token is positional. |
| `--name=value` | Set option `name`. A flag accepts a boolean word (section 5, `bool`) and errors otherwise. |
| `--name` | Flag: set `true`. Otherwise the next token is the value; error if there is none or it starts with `--`. |
| `--no-name` | If an option literally named `no-name` exists, it is that option. Otherwise sets option `name` to `false`; only allowed for flags and for options validated by `bool`, `choice:true,false` or `choice:false,true`. |
| `-` | Positional. |
| `-abc` | Short cluster. For each char: a flag is set `true`; a value option takes the rest of the cluster as its value (`-ofile`), or, if nothing is left, the next token, which must exist and not start with `-`. |
| other | Positional. Assigned to the next positional argument, or appended to the variadic once reached. |

Array options append on every occurrence; scalar options keep the last value.
Options may appear anywhere, including after the variadic starts.

Error messages:

* `Unknown option: --name` / `Unknown option: -x`
* `Option --name requires an argument` / `Option -x requires an argument`
* `Option --name expects a boolean value, got 'V'`
* `Option --no-name can only be used with flag/boolean options`
* `Unexpected argument: TOKEN`

## 3. Resolution pipeline

`run(argv)` performs these steps in order.

1. If `argv` (before any `--`) contains `--help-json-schema`, print the JSON
   schema (section 8) to stdout and exit 0. Likewise `--bash-completion`
   prints completion data (section 9), and `--completion SHELL` prints the
   shell's completion script (section 9); an unknown or missing shell is an
   error, `Unknown shell 'SHELL' (expected bash, zsh or fish)`, exit 1.
2. Register the built-in help option (1.4), then scan the command line (2).
3. If scanning succeeded and a config option is configured, load the config
   file (4).
4. If the help option was set on the command line, print usage (7) to stdout
   and exit 0, whether or not steps 2–3 failed.
5. If steps 2–3 failed, print the error, then usage to stderr, and exit 1.
6. Positional arguments not given take their default. The first one without a
   default is an error: `Missing required positional argument: NAME`.
7. Options not set by the command line or config take, in order, the
   environment variable named `var` (if set and non-empty), then the default.
   Array options ignore the environment.
8. Path options and arguments are resolved (6).
9. Values are validated and converted (5): options in registration order, then
   positional arguments. Empty strings are not validated. Each list element is
   validated.
10. Required commands are checked. If any is missing, print
    `Missing required command(s): a, b` and, for each, a line
    `  CMD - DESCRIPTION` plus `    Install: HINT` when a hint exists; exit 1.
11. Required options (`default` `""`) still empty are an error:
    `Missing required argument(s): --a --b`, then usage to stderr, exit 1.

Errors in steps 6–9 print the error and usage to stderr and exit 1.

Precedence is therefore **command line > config file > environment > default**.

Flags read from config or the environment accept boolean words; any other
value is an error: `Config value for --name must be a boolean, got 'V'` /
`Environment variable VAR must be a boolean, got 'V'`.

Every implementation also offers a non-exiting `parse` that returns the error
instead, and accessors:

* `source(long)`: one of `cli`, `config`, `env`, `default`, `unset`.
* `isSet(long)`: source is `cli`.
* `isExplicitlySet(long)`: source is `cli`, `config` or `env`.

## 4. Config files

Line-oriented, UTF-8. For each line (trailing `\r` removed):

* Blank lines and lines whose first non-space character is `#` are skipped.
* `@include PATH` (leading whitespace allowed, optional surrounding quotes)
  reads another file in place. Relative paths are relative to the including
  file. Maximum depth 10 (`Config include depth exceeded (10) while processing:
  PATH`); a file including itself directly or indirectly is an error
  (`Circular config include detected: PATH`).
* Otherwise, if the line starts with one of the prefixes (first match wins;
  an empty prefix list matches every line), the rest must contain `=`. The key
  is the trimmed text before the first `=` with any leading `--` removed; the
  value is the trimmed text after it. Lines without `=` are skipped.

Later lines override earlier ones, so values after an `@include` override the
included file and values before it are overridden by it.

Keys that are not registered long option names are ignored, which lets several
programs share one file through different prefixes. A key sets an option only
if the command line did not set it. Array options receive a one-element list.

The config path is the config option's command-line value, else its
environment variable, else its default. It is skipped when empty or the literal
`disabled`. It is resolved against the current directory (falling back to the
option's search dirs, section 6) and the resolved absolute path is stored back
in the config option. A missing file is an error: `Config file not found: PATH`.

## 5. Validation rules

`NAME` in messages is `--long` for options and the argument name for
positional arguments. Typed implementations convert values as shown in the
*Type* column; Bash keeps strings.

| Rule | Accepts | Type | Help text | Error |
| --- | --- | --- | --- | --- |
| `int` | `^-?[0-9]+$` | integer | `integer` | `NAME must be an integer, got 'V'` |
| `int:MIN-MAX`, `int:MIN-`, `int:-MAX` | int within bounds | integer | `integer: MIN-MAX`, `integer: >=MIN`, `integer: <=MAX` | `NAME must be >= MIN, got V` / `NAME must be <= MAX, got V` |
| `float` | `^-?[0-9]*\.?[0-9]+$` | number | `number` | `NAME must be a number, got 'V'` |
| `float:MIN-MAX` etc. | float within bounds | number | `number: MIN-MAX` etc. | as int |
| `string` | anything | string | `text` | |
| `string:MIN-MAX`, `string:MIN-`, `string:-MAX` | length in bounds | string | `text: MIN-MAX chars`, `text: >=MIN chars`, `text: <=MAX chars` | `NAME must be at least MIN characters, got LEN` / `NAME must be at most MAX characters, got LEN` |
| `string:N` | length exactly N | string | `text: N chars` | `NAME must be exactly N characters, got LEN` |
| `choice:a,b,c` | exact match | string | `choices: a, b, c` | `NAME must be one of: a, b, c, got 'V'` |
| `path` | anything (marks a path) | string | `path` | |
| `file:exists` | regular file | string | `existing file` | `NAME file does not exist: V` |
| `file:readable` | readable path | string | `readable file` | `NAME file is not readable: V` |
| `file:writable` | writable file, or missing file in writable dir | string | `writable file` | `NAME file is not writable: V` / `NAME directory is not writable: DIR` |
| `dir:exists` | directory | string | `existing directory` | `NAME directory does not exist: V` |
| `dir:writable` | writable directory | string | `writable directory` | `NAME directory does not exist or is not writable: V` |
| `ip` | IPv4 dotted quad or IPv6-ish hex groups | string | `IP address` | `NAME must be a valid IP address, got 'V'` |
| `hostname` | RFC 1123 labels | string | `hostname` | `NAME must be a valid hostname, got 'V'` |
| `url` | `^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$` | string | `URL` | `NAME must be a valid URL, got 'V'` |
| `port` | integer 1–65535 | integer | `port: 1-65535` | `NAME must be a valid port (1-65535), got 'V'` |
| `email` | `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$` | string | `email address` | `NAME must be a valid email address, got 'V'` |
| `uuid` | 8-4-4-4-12 hex | string | `UUID` | `NAME must be a valid UUID, got 'V'` |
| `bool` | `true false yes no 1 0 on off` (any case) | boolean | `true/false, yes/no, 1/0, on/off` | `NAME must be a boolean (true/false, yes/no, 1/0, on/off), got 'V'` |
| `date:YYYY-MM-DD` | `^[0-9]{4}-[0-9]{2}-[0-9]{2}$` | string | `date: YYYY-MM-DD` | `NAME must be in YYYY-MM-DD format, got 'V'` |
| `regex:PATTERN` | pattern found anywhere in value | string | `pattern: PATTERN` | `NAME does not match required pattern, got 'V'` |

Bounds are non-negative decimal numbers. Regex patterns should stay within the
POSIX ERE subset that every engine (Bash `=~`, JS, Python `re`, Rust `regex`,
C `regcomp`) agrees on. The exact regexes for `ip` and `hostname`:

```
ip:       ^([0-9]{1,3}\.){3}[0-9]{1,3}$   or   ^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$
hostname: ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$
uuid:     ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$
```

## 6. Path resolution

Options and arguments whose rule is `path`, `file:*` or `dir:*` are resolved to
absolute paths before validation. Resolution is lexical (`.` and `..` are
collapsed, symlinks are not followed).

These values pass through unchanged: empty, `-`, `disabled`, `optional`,
absolute paths, and anything starting with a scheme (`^[A-Za-z][A-Za-z0-9+.-]+:`,
e.g. `https://…`, `pulse:…`).

The base directory depends on where the value came from:

| Source | Base |
| --- | --- |
| command line, positional arguments | current working directory |
| config file | directory of the file that contained the line |
| environment, default | `root` |

For options with search dirs: a *bare* relative value (not `.`, `..`, and not
starting with `./` or `../`) that does not exist under the base is looked up in
each search dir in order; the first that contains it wins. If none does, the
base-relative path is used so that errors name the path the user expects.
Search dirs themselves are resolved against `root`. Positional arguments have
no search dirs.

## 7. Help text

Output is a sequence of sections joined by a single blank line, ending with a
newline. Lines have no trailing whitespace.

`MAXW` is the integer in `CLYOPS_MAX_WIDTH`, else `100`.

1. **Usage line:** `Usage: NAME` then, per positional argument, ` <name>`
   (required), ` [<name>]` (has default) or ` [<name>...]` (variadic), then
   ` [OPTIONS]`.
2. **Description** (if any), word-wrapped at `MAXW`.
3. **`Positional Arguments:`** (if any), one row per argument.
4. **`Required Commands:`** (if any), one row per command. Label is
   `CMD [installed]` or `CMD [not found]`; text is the description followed by
   ` (HINT)` when a hint exists.
5. One section per option group, in order of first appearance, headed
   `GROUP:`, one row per option in registration order.
6. **Epilog** (if any), verbatim with trailing newlines removed.

Option labels are `-s, --long` or `    --long` (four spaces when there is no
short), followed by `=<value>` unless the option is a flag.

The description column `INDENT` is `clamp(L + 4, 32, 50)` where `L` is the
longest option label. A row is `"  " + label`, padded with spaces to `INDENT`
(or followed by one space if it is already that long), then the text wrapped
at `max(20, MAXW - INDENT)` with continuation lines indented by `INDENT`
spaces.

Row text is the description followed by ` (A, B, …)` when there are
annotations:

* Arguments: `variadic`; `default: D`; `accepts: HELP` (section 5 help text).
* Options: `required` (default `""`); `multiple` (array); `config: V` (the
  config file has the key); `default: D` (a real default, not for flags or
  `optional`); `accepts: HELP`.

Word wrapping keeps existing line breaks, splits words on whitespace, and
greedily fills lines to the width (a single word longer than the width gets a
line of its own).

## 8. JSON schema (`--help-json-schema`)

```json
{
  "clyops": 1,
  "script": "NAME",
  "description": "…",
  "epilog": "…",
  "arguments": [
    { "name": "", "description": "", "required": true, "isVariadic": false, "default": "", "validation": "" }
  ],
  "options": [
    { "name": "", "shortName": "", "variableName": "", "description": "", "default": "",
      "group": "", "type": "string", "isFlag": false, "isArray": false, "required": false,
      "validation": "", "choices": [] }
  ],
  "requiredCommands": [
    { "command": "", "description": "", "installHint": "" }
  ]
}
```

`default` is `"false"` for flags and `""` for `optional`. `type` is
`boolean` (flags and `bool`), `integer` (`int*`, `port`), `number` (`float*`),
`choice` (`choice:*`), `path` (`path`, `file:*`, `dir:*`) or `string`.
`choices` lists the `choice:` values. Output is indented with two spaces. [schema.json](schema.json) is the formal JSON Schema of this output.

## 9. Completion data (`--bash-completion`)

Tab-separated records, one per line, after a header line `#clyops-completion 1`:

```
opt  --LONG  -S|-  flag|value  KIND  VALUES|-  DESCRIPTION
arg  NAME    single|variadic   KIND  VALUES|-  DESCRIPTION
```

Tabs and newlines inside descriptions become spaces. Each flag is followed by a
`--no-LONG` record (`-`, `flag`, `none`, `-`). Value options validated by
`bool` or `choice:true,false`/`choice:false,true` are also followed by a
`--no-LONG` flag record.

| Rule | Kind | Values |
| --- | --- | --- |
| `path`, `file:*` | `file` | search dirs joined by `:` |
| `dir:*` | `dir` | search dirs joined by `:` |
| `choice:*` | `choice` | the choices, comma-separated |
| `bool` | `choice` | `true,false` |
| `hostname`, `ip` | `host` | |
| `int*`, `float*`, `port`, `uuid`, `url`, `email`, `date:*`, `regex:*`, `string*` | `none` | |
| none | `default` | |

### 9.1 Shell completion scripts

Every program can install its own completion. `--completion bash|zsh|fish`
prints a script that registers completion for the program's name:

```sh
eval "$(prog --completion bash)"                                   # ~/.bashrc
eval "$(prog --completion zsh)"                                    # ~/.zshrc (after compinit)
prog --completion zsh > "${fpath[1]}/_prog"                        # or install for autoload
prog --completion fish > ~/.config/fish/completions/prog.fish      # fish
```

The scripts are the templates in `spec/completions/` with `__CLYOPS_PROG__`
replaced by the program name and `__CLYOPS_FUNC__` by the name with every
character outside `[A-Za-z0-9_]` replaced by `_`. Each package embeds the same
templates (`tools/sync-completions.py`), so the output is byte-identical across
languages. At completion time the scripts run `prog --bash-completion` and use
the records above, so they never go stale:

* option names, short and long, with descriptions (zsh, fish);
* option values by kind: choices, files and directories (including the
  option's search dirs), host names;
* positional arguments by position, skipping options and their values, with
  the variadic argument repeating.

`tools/test-completions.sh` drives the scripts in real bash, zsh and fish.

## 10. Resolved values as JSON

`valuesJson()` returns an object keyed by option `var` (registration order,
including `HELP`) then argument name. Flags are booleans; values validated by
`int*` and `port` are integers, `float*` numbers, `bool` booleans; everything
else is a string. Array options and variadics are lists. Unset values are
`null`.

## 11. Logging

Every package ships the same helpers: `info`, `warn`, `error`, `success`,
`die(code, message)`. Each writes `YYYY-MM-DD HH:MM:SS [LEVEL] MESSAGE` to
stderr, where `LEVEL` is `info`, `warning`, `error`, `success` or `error` (for
`die`). The level is colored only when stderr is a terminal and `NO_COLOR` is
unset. Setting `CLYOPS_SILENT=true` (or the package's silent switch) suppresses
everything except `die` and parse errors.
