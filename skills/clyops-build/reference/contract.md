# The clyops contract (condensed spec v1)

The authoritative text is `spec/SPEC.md`. Section numbers below point into it.

## Options (§1.1)

| Field | Meaning |
| --- | --- |
| `var` | Key in resolved values **and** the environment variable read for the option |
| `long` | Long name without `--`; unique |
| `short` | One character without `-`, or empty |
| `default` | `flag`, `optional`, `""` (required) or a literal default |
| `description` | Help text |
| `group` | Help section; default `Options` |
| `rule` | Validation rule (below); empty means free text |

Default sentinels:

| `default` | Meaning |
| --- | --- |
| `flag` | Boolean, takes no value, `false` when unset. `--name`, `--no-name`, `--name=false` |
| `optional` | Not required, no default; resolves to null |
| `""` | Required: missing after config/env/default is an error |
| other | Literal default, validated and converted like any value |

**Array options** (`optArray`, `opt_array`, …) take `var, long, short,
description, group, rule` (no default): every occurrence appends, never
required, empty list when not given, ignore the environment.

## Positional arguments (§1.2)

`arg(name, description, default, rule)`: an empty default means required.
`argVariadic(name, description, rule)` collects the rest, must be last, is never
required, resolves to a list. Positional arguments cannot be secret and have no
search dirs.

## Metadata (§1.3)

`description`, `epilog`, `name` (default: basename of argv[0]), `root` (base
for default/env paths), `config(option, prefixes)`, `requireCommand(cmd,
description, installHint)`, `pathSearch(long, dirs)`, `effects(...)`,
`stdin(description, contentType)`, `stdout(description, contentType)`,
`role(name, in|out, description, contentType, schema)`, relationships and
commands.

* **Effects**: `read-only` (changes nothing), `idempotent` (twice = once),
  `destructive` (deletes or overwrites), `network` (talks to the outside
  world). Each call replaces the list. Unset means unknown.
* **stdin/stdout**: `contentType` is a MIME type; stdin may list several
  (`audio/wav,audio/flac`). Undeclared stdin = not read; undeclared stdout =
  text.
* **Roles** (§14): extra streams on descriptors the *runner* chooses, never a
  fixed fd number. Well-known names: `meta` (one JSON document about stdout,
  written before it), `progress` (one JSON object per line; `pct`,
  `done`/`total`, `stage`, `message`), `log`, `result`. Write with
  `emit(name, value)` after parsing; it does nothing unless the runner mapped
  the role in `CLYOPS_FDS` (`meta:3,progress:4`), so the tool still works with
  only stdio. By hand: `CLYOPS_FDS=progress:2 mytool` shows progress on stderr.

Registration mistakes (unknown rule, duplicate long/short name, positional after
a variadic, unknown effect, relationship naming an unregistered option, commands
mixed with positionals) are programming errors: exceptions/panics, or a message
and exit status 2 in Bash and C.

## Built-in help (§1.4)

`--help`/`-h` (`HELP`, group `Global`) is added automatically, last. `-h` is
skipped if another option already uses it.

## Secrets (§1.5)

Rule `secret`, or `secret:RULE` to also validate (`secret:string:32-`). Help
shows `config: ***` and the annotation `secret`; `valuesJson()` shows `"***"`;
the schema has `"secret": true`. The program reads the real value. Prefer the
environment or a config file over the command line (visible in `ps`).

## Relationships (§1.6)

| Call | Meaning | Error |
| --- | --- | --- |
| `exclusive(A, B, …)` | at most one given | `Options --A and --B cannot be used together` |
| `requires(A, B, …)` | if A is given, all others are too | `Option --A requires --B` |
| `oneOf(A, B, …)` | at least one given | `One of --A, --B is required` |

`exclusive` + `oneOf` over the same options = exactly one. "Given" means set by
the command line, config or environment and not `false`/empty. Defaults never
count. Register the options first.

## Commands (§1.7)

`command(name, description)` returns a nested CLI to register on (Bash:
`clyops_command "db migrate" "…"` and later registrations belong to it). A level
has commands or positionals, not both. Ancestors' options are accepted at any
depth, before or after command words; register them before the commands. The
selected words are available as `command` (e.g. `["db", "migrate"]`). Config is
the program's. Each command has its own help, schema and completion. Each leaf
command becomes its own tool in the API and MCP server (`tasks_db_migrate`).

## Parsing (§2)

`--` ends options. `--name=value`, `--name value`, `-n value`, `-nvalue`,
clustered flags `-vq`. `--no-name` only for flags and `bool` /
`choice:true,false` options. Scalars keep the last value; arrays append.
Errors: `Unknown option: --name`, `Option --name requires an argument`,
`Unexpected argument: TOKEN`, `Unknown command: TOKEN`, `Missing command`,
`Missing required positional argument: NAME`,
`Missing required argument(s): --a --b`.

## Resolution (§3)

`--help-json-schema`, `--bash-completion`, `--completion SHELL` are handled
first. Then scan, load config, show help if asked, report scan errors (exit 1,
usage on stderr), fill env then defaults, resolve paths, validate and convert
(empty strings are not validated), check required commands, required options,
then relationships.

Because `run` exits for help, schema, completion and every error, **a tool must
do no work before `run` returns successfully**: no connections, file writes,
network calls or output. The dispatcher, API and MCP server probe tools with
`--help-json-schema` and `--bash-completion` and rely on this (§12).

**Precedence: command line > config file > environment > default.** Accessors:
`source(long)` → `cli|config|env|default|unset`; `isSet` (cli);
`isExplicitlySet` (cli, config or env).

## Config files (§4)

Register an option (usually `optional`, rule `path`) and `config(option,
"prefix:,other:")`. Lines are `prefix:key=value`; `#` comments; `@include PATH`
(relative to the including file, depth 10, cycles are errors). Keys are long
names (leading `--` stripped); unknown keys are ignored so several programs can
share one file. Path `disabled` or empty skips loading; a missing file is an
error.

## Validation rules (§5)

| Rule | Accepts | Converts to |
| --- | --- | --- |
| `int`, `int:MIN-MAX`, `int:MIN-`, `int:-MAX` | integer (in bounds) | integer |
| `float`, `float:MIN-MAX`, … | number (in bounds) | number |
| `string`, `string:MIN-MAX`, `string:MIN-`, `string:-MAX`, `string:N` | text, length bounds | string |
| `choice:a,b,c` | exact match | string |
| `bool` | `true false yes no 1 0 on off` (any case) | boolean |
| `port` | 1–65535 | integer |
| `path` | anything; marks a path (resolved to absolute) | string |
| `file:exists`, `file:readable`, `file:writable` | file checks (writable allows a missing file in a writable dir) | string |
| `dir:exists`, `dir:writable` | directory checks | string |
| `ip`, `hostname`, `url` (`http`/`https` only), `email`, `uuid` | format | string |
| `date:YYYY-MM-DD` | that format | string |
| `regex:PATTERN` | pattern found anywhere (anchor it yourself) | string |
| `secret`, `secret:RULE` | as `RULE`, masked | as `RULE` |

Bounds are non-negative decimals. Keep regexes to the POSIX ERE subset every
engine shares. Bash keeps every value as a string; flags and `bool` become
`true`/`false`.

## Paths (§6)

Values with rule `path`, `file:*`, `dir:*` become absolute (lexically, no
symlink resolution). Unchanged: empty, `-`, `disabled`, `optional`, absolute
paths, anything with a scheme (`https://…`). Base: the working directory for the
command line and positionals, the config file's directory for config values,
`root` for environment and defaults. `pathSearch` adds fallback directories for
bare relative names.

## Schema (`--help-json-schema`, §8)

Top level: `clyops` (1), `script`, `description`, `epilog`, `arguments[]`,
`options[]`, `config` (`option`, `prefixes[]`, or `null`; the program's only),
`requiredCommands[]`, `effects[]`, `constraints[]`, `stdin`,
`stdout`, `roles[]` (`name`, `direction`, `description`, `contentType`,
`schema`), `commands[]`. Each option has `name`, `shortName`, `variableName`,
`description`, `default`, `group`, `type` (`boolean|integer|number|choice|path|string`),
`isFlag`, `isArray`, `required`, `validation`, `choices`, `secret`. Each argument
has `name`, `description`, `required`, `isVariadic`, `default`, `validation`.
Commands repeat the shape with `name` and only their own options. The formal
JSON Schema is `spec/schema.json`.

## Resolved values (§10)

`valuesJson()`: keyed by option `var` (including `HELP`), then argument names,
then `command`. Flags/`bool` are booleans, `int*`/`port` integers, `float*`
numbers, everything else strings; arrays and variadics are lists; unset is
null; set secrets are `"***"`.

## Logging (§11)

`info`, `warn`, `error`, `success`, `die(code, message)` write
`YYYY-MM-DD HH:MM:SS [LEVEL] MESSAGE` to stderr. Color only on a TTY without
`NO_COLOR`. `CLYOPS_SILENT=true` suppresses all but `die` and parse errors.

## Discovery (§12)

The dispatcher, API and MCP server run a program for its schema only when its
source opts in: sourcing `clyops.sh`; Python `import clyops`/`from clyops`;
JS/TS `require`/`import` of `clyops` or a local `clyops.cjs/.js/.mjs/.ts`; an
exact standalone `# clyops-tool` or `// clyops-tool` comment in the first ten
lines; a binary containing `#clyops-completion`; or a `clyops-dispatch` shebang.
Mentions in comments, strings, docstrings and here-documents do not count. The
schema probe has a five-second timeout and must return `"clyops": 1`.
