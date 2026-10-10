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
* `effects(EFFECT...)`: what running the program does, for the agents and
  servers that run it on someone's behalf (section 8): `read-only` (changes
  nothing), `idempotent` (running it twice is the same as once), `destructive`
  (deletes or overwrites things) and `network` (talks to the outside world).
  Each call replaces the list; unset means unknown.
* `stdin(description, contentType)` / `stdout(description, contentType)`:
  what the program reads on standard input and writes on standard output.
  `contentType` is a MIME type (`audio/wav`); for stdin it may be a
  comma-separated list of accepted types (`audio/wav,audio/flac`). Undeclared
  stdin means the program doesn't read it; undeclared stdout means text.
* Option relationships (1.6) and commands (1.7).

Registering an unknown validation rule, a duplicate long/short name, a
positional argument after a variadic, an unknown effect (`Unknown effect 'E'`),
a relationship naming an option that isn't registered (`Unknown option --NAME
in constraint`), or mixing commands and positional arguments on one level
(`Cannot mix commands and positional arguments`) is a programming error,
reported at registration time in the language's usual way (exception, panic, or
a message and exit status 2 in Bash and C), e.g. `Unknown validation rule 'R'
for --NAME`.

### 1.4 Built-in help option

When parsing starts, if no option named `help` exists, implementations register
`var=HELP long=help short=h default=flag group=Global description="Show this
help message and exit"`. The short `-h` is omitted if another option already
uses `h`. It is registered last, so `Global` is the last group unless the user
also used it.

### 1.5 Secret options

An option whose rule is `secret`, or `secret:RULE` for a secret that is also
validated by `RULE` (`secret:string:32-`), holds a secret such as an API key or
a token. Its validation is `RULE` (empty for a bare `secret`) everywhere else;
the secret marking only changes what is shown:

* help prints `config: ***` instead of the value from the config file, and
  adds the annotation `secret` (section 7);
* `valuesJson()` prints `"***"` for a set value (a list of them for an array
  option); the program still reads the real value through the usual accessors;
* the schema marks the option `"secret": true` (section 8), so consumers can
  redact it, keep it out of logs and use a password field.

Values on the command line are visible to other users in `ps`; prefer the
environment or a config file for secrets. Positional arguments can't be secret.

### 1.6 Option relationships

Three registrations, each naming registered long options:

| Registration | Meaning | Error |
| --- | --- | --- |
| `exclusive(A, B, ...)` | at most one of them is given | `Options --A and --B cannot be used together` |
| `requires(A, B, ...)` | when A is given, every other one is too | `Option --A requires --B` |
| `oneOf(A, B, ...)` | at least one of them is given | `One of --A, --B is required` |

(`exclusive` plus `oneOf` over the same options means exactly one.) An option
**is given** when its source is `cli`, `config` or `env` and its value is not
`false` (so `--no-quiet` doesn't count) or an empty list. Defaults never count.
The errors name the first two given options (`exclusive`), the first missing
one (`requires`) or every option (`oneOf`), in the order registered.

### 1.7 Commands

A program can have **commands**, each a nested CLI with its own options,
arguments, metadata and commands of its own: `mytool db migrate --to 3`.
`command(name, description)` registers a command and returns it to register
on. A level has either commands or positional arguments, not both.

* The program's own options (and every ancestor's) are accepted at any depth,
  before and after the command words; a command's options only after its word.
  Register a level's options before its commands: an option of a command that
  reuses a name of an ancestor's option shadows it.
* The **chain** of a run is the selected command, its parent, and so on up to
  the program. The chain's options, in that order, are what is resolved,
  validated, shown in help and printed by `valuesJson()`; its required commands
  and relationships are checked, from the program down. Positional arguments are the selected
  command's. Config files (section 4) are the program's: `config()` is
  registered on the program, and its keys set the chain's options.
* The selected command words are available as `command` (a list, e.g.
  `["db", "migrate"]`; empty when no command was given) through an accessor in
  each language, and in `valuesJson()` under the key `command`.


Tokens are processed left to right. Scanning stops at the first error.

| Token | Behavior |
| --- | --- |
| `--` | Every later token is positional. |
| `--name=value` | Set option `name`. A flag accepts a boolean word (section 5, `bool`) and errors otherwise. |
| `--name` | Flag: set `true`. Otherwise the next token is the value; error if there is none or it starts with `--`. |
| `--no-name` | If an option literally named `no-name` exists, it is that option. Otherwise sets option `name` to `false`; only allowed for flags and for options validated by `bool`, `choice:true,false` or `choice:false,true`. |
| `-` | Positional. |
| `-abc` | Short cluster. For each char: a flag is set `true`; a value option takes the rest of the cluster as its value (`-ofile`), or, if nothing is left, the next token, which must exist and not start with `-`. |
| other | Positional. At a level with commands, the name of the command to descend into (error if there is no such command); otherwise assigned to the next positional argument, or appended to the variadic once reached. |

Array options append on every occurrence; scalar options keep the last value.
Options may appear anywhere, including after the variadic starts.

Error messages:

* `Unknown option: --name` / `Unknown option: -x`
* `Option --name requires an argument` / `Option -x requires an argument`
* `Option --name expects a boolean value, got 'V'`
* `Option --no-name can only be used with flag/boolean options`
* `Unexpected argument: TOKEN`
* `Unknown command: TOKEN`

Options are looked up in the chain selected so far, the deepest command first.

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
6. If scanning ended at a level with commands, that is an error:
   `Missing command`. Positional arguments not given take their default. The
   first one without a default is an error: `Missing required positional
   argument: NAME`.
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
12. Option relationships (1.6) are checked, in the order registered, from the
    program down the chain. The first that fails is an error, then usage to
    stderr, exit 1.

Errors in steps 6–9 print the error and usage to stderr and exit 1. Usage is
always that of the selected command.

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

Help is that of the selected command (1.7): `mytool db --help` describes
`db`.

1. **Usage line:** `Usage: NAME` (for a command, the program name and the
   command words: `Usage: mytool db migrate`) then ` <command>` at a level with
   commands, or per positional argument ` <name>` (required), ` [<name>]` (has
   default) or ` [<name>...]` (variadic), then ` [OPTIONS]`.
2. **Description** (if any), word-wrapped at `MAXW`.
3. **Input and output** (if declared): `Input: DESCRIPTION (TYPE)` and
   `Output: DESCRIPTION (TYPE)` lines, leaving out an empty description or type.
4. **`Commands:`** (if any), one row per command: its name and description.
5. **`Positional Arguments:`** (if any), one row per argument.
6. **`Required Commands:`** (if any) of the chain, from the program down, one
   row per command. Label
   is `CMD [installed]` or `CMD [not found]`; text is the description followed
   by ` (HINT)` when a hint exists.
7. One section per option group of the chain's options, in order of first
   appearance, headed `GROUP:`, one row per option in registration order.
8. **Epilog** (if any), verbatim with trailing newlines removed.

Option labels are `-s, --long` or `    --long` (four spaces when there is no
short), followed by `=<value>` unless the option is a flag.

The description column `INDENT` is `clamp(L + 4, 32, 50)` where `L` is the
longest option label or command name. A row is `"  " + label`, padded with spaces to `INDENT`
(or followed by one space if it is already that long), then the text wrapped
at `max(20, MAXW - INDENT)` with continuation lines indented by `INDENT`
spaces.

Row text is the description followed by ` (A, B, …)` when there are
annotations:

* Arguments: `variadic`; `default: D`; `accepts: HELP` (section 5 help text).
* Options: `required` (default `""`); `multiple` (array); `secret`;
  `config: V` (the config file has the key; `config: ***` for a secret);
  `default: D` (a real default, not for flags or `optional`); `accepts: HELP`;
  then per relationship it is in (1.6): `conflicts with: --B, --C` (the other
  options of an `exclusive`), `requires: --B, --C` (when it is the first option
  of a `requires`) and `one of: --A, --B` (every option of a `oneOf`).

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
  ],
  "effects": ["read-only"],
  "constraints": [
    { "type": "exclusive", "options": ["json", "quiet"] }
  ],
  "stdin": { "description": "", "contentType": "" },
  "stdout": null,
  "commands": [
    { "name": "", "description": "", "epilog": "", "arguments": [], "options": [],
      "requiredCommands": [], "effects": [], "constraints": [], "stdin": null, "stdout": null,
      "commands": [] }
  ]
}
```

`default` is `"false"` for flags and `""` for `optional`. `type` is
`boolean` (flags and `bool`), `integer` (`int*`, `port`), `number` (`float*`),
`choice` (`choice:*`), `path` (`path`, `file:*`, `dir:*`) or `string`.
`choices` lists the `choice:` values. Options also have `"secret"` (1.5).
`effects` lists the declared effects (1.3) in the order given; `constraints`
the relationships (1.6) in registration order, `type` being `exclusive`,
`requires` or `oneOf` and `options` the long names; `stdin` and `stdout` are
`null` unless declared. `commands` holds each command (1.7) with the same
fields as the program, `name` in place of `clyops` and `script`, and only its
own options. Output is indented with two spaces. [schema.json](schema.json) is the formal JSON Schema of this output.

## 9. Completion data (`--bash-completion`)

Tab-separated records, one per line, after a header line `#clyops-completion 1`:

```
opt  --LONG  -S|-  flag|value  KIND  VALUES|-  DESCRIPTION
arg  NAME    single|variadic   KIND  VALUES|-  DESCRIPTION
```

The scripts call `prog --bash-completion -- WORD...` with the words typed
after the program name, up to the word being completed. A program built on a
clyops library ignores them. A dispatcher (section 12) uses them to answer for
the subcommand being typed, with two more records:

```
skip  N                  the first N words are subcommand names; complete as if the line started after them
cmd   NAME  DESCRIPTION  a subcommand that can be typed at this position
```

A program with commands (1.7) answers like a dispatcher: it follows the words
through its commands, stopping at the first that isn't one, and prints
`skip N` (the command words followed), then a `cmd` record per command of
that level, then the `opt` records of the chain and the `arg` records of the
selected command. A word that is neither an option nor a command where one
is expected gives only the header.

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

`valuesJson()` returns an object keyed by option `var` (the chain's options,
section 1.7, each level in registration order, including `HELP`) then argument
name, then `command` for a program with commands. Flags are booleans; values validated by
`int*` and `port` are integers, `float*` numbers, `bool` booleans; everything
else is a string. Array options and variadics are lists. Unset values are
`null`. Set secrets (1.5) are `"***"`.

## 11. Logging

Every package ships the same helpers: `info`, `warn`, `error`, `success`,
`die(code, message)`. Each writes `YYYY-MM-DD HH:MM:SS [LEVEL] MESSAGE` to
stderr, where `LEVEL` is `info`, `warning`, `error`, `success` or `error` (for
`die`). The level is colored only when stderr is a terminal and `NO_COLOR` is
unset. Setting `CLYOPS_SILENT=true` (or the package's silent switch) suppresses
everything except `die` and parse errors.

## 12. Dispatchers (`clyops-dispatch`)

A dispatcher turns a directory of tools into one command with nested
subcommands. It is a definition file whose shebang runs `clyops-dispatch`:

```
#!/usr/bin/env clyops-dispatch
description: mytool toolchain
ignore: lib, docx
```

Without a definition file, `clyops-dispatch --root DIR [--name NAME] ...` does
the same for `DIR`, named `NAME` (default: the directory's name); `DIR/.clyops`
supplies `description` and `ignore`. This suits a shell alias or function:

```sh
alias mytool='clyops-dispatch --root ~/mytool/scripts --name mytool'          # bash, fish
mytool() { clyops-dispatch --root ~/mytool/scripts --name mytool "$@"; }       # zsh, bash, fish
```

zsh expands aliases before completing, so there the function form is needed.
With `--root`, `--completion` prints a script that calls
`clyops-dispatch --root DIR --name NAME` instead of the typed program name, which
an alias would not resolve inside the script.

Lines are `key: value`; blank lines and `#` comments are ignored, and unknown
keys are errors. Keys: `description` (help text), `dir` (tools directory,
relative to the definition; default: the definition's directory), `ignore`
(comma-separated names to leave out), and `allow` and `deny`
(comma-separated tool patterns that servers such as clyops-api and
clyops-mcp apply, section 13; the dispatcher accepts and ignores them). The definition's real path (symlinks
resolved) locates the tools, so it can be symlinked into `PATH`; the name it is
run by is the program name.

**The tree.** In each directory, ignoring hidden entries:

* an executable file is a **command** named after its file name without the
  last extension (`media-to-pcm.sh` → `media-to-pcm`); the first in sorted
  order wins when two share a name;
* a subdirectory containing at least one command (at any depth) is a **group**
  with the same name, and shadows a command of that name. An optional
  `.clyops` file in it accepts `description` and `ignore`.

`prog a b c ARGS...` follows `a` and `b` through groups and runs command `c`
with `ARGS` (replacing the process on Unix), in the caller's directory.

**Help.** `prog`, `prog --help` and `prog GROUP [--help]` print:

```
Usage: prog GROUP... <command> [args...]

DESCRIPTION

Groups:
  NAME   DESCRIPTION
Commands:
  NAME   DESCRIPTION
Global:
  -h, --help                Show this help message and exit
      --completion=<value>  Print a completion script for bash, zsh or fish

Run 'prog GROUP... <command> --help' for a command's options.
```

laid out like section 7. A command's description is the first line of the
`description` in its `--help-json-schema` output; a nested dispatcher's is
read from its definition. Descriptions are cached in
`$XDG_CACHE_HOME/clyops-dispatch/` (else `~/.cache`) until the file's size or
modification time changes. `prog GROUP --list` prints the names at that level.
An unknown command or option is an error (`Unknown command: X`), followed by
the help on stderr, exit 1.

**Which programs are run.** Describing or completing a command executes it.
The check exists to avoid running arbitrary executables with an unknown flag,
which could do real work. A comment, string, URL or passing mention of clyops
is not an opt-in. Only these conservative source patterns qualify:

* a line sourcing `clyops.sh` with `source` or `.`, including quoted paths;
* a Python `import clyops` or `from clyops` statement;
* JavaScript/TypeScript `require('clyops…')` or `import … from 'clyops…'`
  (also side-effect imports and local `…/clyops.cjs`, `.js`, `.mjs`, `.ts` paths);
* an exact standalone `# clyops-tool` or `// clyops-tool` comment in the first
  ten lines, for wrappers or loaders that don't match these patterns;
* `#clyops-completion` embedded in a binary (a file with NUL bytes, without
  a shebang); or a shebang naming `clyops-dispatch` (nested dispatchers).

Comments and quoted documentation, including multiline strings and shell
here-documents, are skipped. This is conservative source inspection, not a
proof of program behavior: opting in asserts that the program handles the
probe flags without doing work. A schema probe has a five-second timeout and
must return a schema with `"clyops": 1`. Schemas/descriptions are cached by
file stamp, so hot reload only probes changed tools. Other executables are
listed by the dispatcher without a description and complete file names;
API/MCP servers don't offer them as tools.

**Completion.** `prog --completion SHELL` prints the section 9.1 script for the
dispatcher's name. `prog --bash-completion -- WORD...` follows the words like
running does:

* at a group: `skip N` (the group words) and a `cmd` record per entry, plus
  `--help` and `--completion` option records;
* at a command: `skip N` (the words up to and including the command) followed
  by the command's own records from `COMMAND --bash-completion -- REST...`; a
  nested dispatcher's `skip` is added to N;
* at an unknown word: only the header.

## 13. JSON input (`toArgv`)

Programs that run clyops tools on someone else's behalf (an API, an MCP
server, a job engine) take the input as a JSON object and turn it into a
command line using the tool's `--help-json-schema` (section 8). The reference
implementation is `toArgv` in [clyops-tools](../packages/tools).

**Keys.** An option or argument is matched by the first key present among:
its name with `-` replaced by `_` (`dry_run`), its literal name (`dry-run`),
and, for options, its `variableName` in lower case (`dry_run`). Keys that
match nothing are reported back to the caller, which decides whether that is
an error. A `null` value is the same as leaving the key out.

**Options** keep schema order:

* a flag (`isFlag`, unless its choices are `true,false`) becomes `--name` when
  the value is `true` or one of `true 1 yes on` (any case), and `--no-name`
  when the value is `false` or one of `false 0 no off` (any case), so `false`
  overrides a config file or environment variable. Flag values are rendered
  before validation; other strings or shapes are input errors, never silently
  false. Absent `null`/`undefined` inputs are still skipped;
* any other option becomes `--name VALUE`, repeated for each element when the
  value is an array (array options);
* values are strings as given, numbers and booleans in their JSON spelling,
  objects as JSON text.

**Positionals** come first by default, without an option terminator, so
legacy wrappers taking their input as `$1` work too. When any positional
starts with `-`, all positionals instead follow the options and `--`, so
none can be read as an option. A caller can request positionals last with
`toArgv(schema, input, { positionals: 'last' })`; it emits `--` only for dash
values in that order too. Explicit positional arrays remain supported, with
`positionalsOrder: 'first' | 'last'` to set their order. Jobs configure this
with a function's `positionals_order`, and API/MCP servers expose
`--positionals-order` (or `positionalsOrder` in their Node API).
Arguments are filled in schema order;
an array fills a variadic. An argument left out before one that is given takes
its `default`; without one, the input is an error
(`ARG is given, so EARLIER must be too`).

**Paths.** A caller may give a base directory: then relative values of path
options and arguments (`path`, `file:*`, `dir:*`) are resolved against it,
except `-`, URLs (`scheme://...`) and the `disabled`/`false` sentinels.
Without one, the tool resolves them against its working directory as usual
(section 6).

**Secrets** (section 1.5). A caller may pass secret options in the
environment, under their variable names, instead of on the command line where
other users can see them in `ps`; array options stay on the command line.
Then a value in the tool's config file takes precedence, as usual. Command
lines shown or logged replace a secret's value with `***`.

**Commands** (section 1.7). Each command without commands of its own is a
tool: its words follow the program's (`tasks db migrate`), its command line
starts with them, and its schema has the command's arguments, the options of
the command and of every command above it (nearest first), the nearest
declared effects, stdin and stdout, and every relationship and required
command on the way.

**Serving tools.** A server exposing tools to callers (an API, an MCP
server) can limit which: `allow` and `deny` patterns are globs over a tool's
words joined by `/` (`*` within a word, `**` across words; a tool must match
an `allow` pattern when there are any, and no `deny` pattern), from its own
options and from the root `.clyops` file (both apply); a read-only mode
serves only tools declaring the `read-only` effect. Path inputs can be
confined to directories: the value, resolved like above with symlinks
followed, must lie inside one of them, and values with a scheme are refused.

**JSON Schema.** The input's JSON Schema has one property per argument and
option (except `help`) under the key above. Types follow the validation rule:
`int` → `integer` with `minimum`/`maximum` from the bounds, `float` →
`number`, `port` → `integer` 1–65535, `bool` and flags → `boolean`, `choice` →
string `enum`, `string:` bounds → `minLength`/`maxLength`, `regex:` →
`pattern`, and `ip`, `hostname`, `url`, `email`, `uuid` and `date` → `pattern`
with the section 5 regex; everything else is a string. Array options and
variadics are arrays of that. Descriptions and typed defaults are carried
over; secret options are marked `writeOnly: true` and `format: "password"`.
Required arguments are required; options are not, since a tool may get
a required option from its environment or a config file. Each pair of
`exclusive` options becomes an `allOf` entry `{"not": {"required": [A, B], …}}`
(a flag given as `false` or a `null` value doesn't count); the other
relationships are left to the tool, like required options.
