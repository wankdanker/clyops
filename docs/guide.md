---
title: Concepts and behavior
---
# Concepts and behavior

The APIs use native naming conventions, with the same underlying behavior.
The [language guides](reference.md) show their signatures and runnable programs.
This guide uses JavaScript spelling for recipes; register everything before `run()`.

## Register options and arguments

```javascript
cli.opt('PORT', 'port', 'p', '8080', 'Server port', 'Network', 'port');
cli.opt('VERBOSE', 'verbose', 'v', 'flag', 'Verbose output');
cli.opt('TOKEN', 'token', '', '', 'Required token', 'Auth', 'secret');
cli.optArray('TAG', 'tag', 't', 'Repeatable tags');
cli.arg('INPUT', 'Input file', '', 'file:exists');
cli.argVariadic('EXTRA', 'Additional input files', 'file:exists');
```

| Parameter | Meaning |
| --- | --- |
| variable | Key in resolved values and the environment variable name, e.g. `PORT` |
| long | Long option without `--`, e.g. `port` |
| short | Single-character alias without `-`; empty means no alias |
| default | Literal default, `flag`, `optional`, or empty for a required option |
| description | Text shown in help and the schema |
| group | Help section; defaults to `Options` |
| rule | Validation rule; empty means text |

Repeatable options accumulate CLI values; positional arguments are assigned in
registration order. A variadic must be last. An empty positional default makes
it required. A CLI level contains positionals or subcommands, not both.

| Operation | JS / Java | Python / Ruby | Rust | Go | Bash / C |
| --- | --- | --- | --- | --- | --- |
| Option | `opt` | `opt` | `opt` | `Opt` | `clyops_opt` |
| Repeatable option | `optArray` | `opt_array` | `opt_array` | `OptArray` | `clyops_opt_array` |
| Argument | `arg` | `arg` | `arg` | `Arg` | `clyops_arg` |
| Variadic | `argVariadic` | `arg_variadic` | `arg_variadic` | `ArgVariadic` | `clyops_arg_variadic` |

Rust puts option `group` and `rule` on the returned registration handle; C uses
designated metadata fields. See each native reference before translating a recipe.

## Values, precedence and flags

Precedence is **command line → config → environment → default**. Integer, float,
boolean and flag rules produce native typed values; arrays contain typed elements.
Unset optional values are null/nil/None or the language's documented empty value.

`--verbose` enables a flag; `--no-verbose` explicitly disables it and overrides an
enabled environment/config value. `--verbose=false` is also supported. Boolean
words are case insensitive: true/false, yes/no, 1/0, on/off.

`source('port')` reports `cli`, `config`, `env`, `default` or `unset`.
`isSet` asks whether it came from CLI; `isExplicitlySet` includes config and env.
Ruby uses `set?` and `explicitly_set?`; Bash/C use the `clyops_` forms.
Typed getters may return a default for the wrong type; check presence/type when
that difference matters. Runtime registration does not infer application-specific
field types in TypeScript, Python or Ruby.

## Validation

Rules include `int`, `float`, `bool`, `port`, `ip`, `hostname`, `url`, `email`,
`uuid`, `date:YYYY-MM-DD`, `path`, `file:exists`, `file:readable`, `file:writable`,
`dir:exists` and `dir:writable`. Parameterized rules include `int:1-10`,
`float:0-1`, `string:1-100`, `choice:red,green,blue` and `regex:PATTERN`.
See [spec section 5](../spec/SPEC.md#5-validation-rules) for ranges and exact behavior.

Standalone `validate` helpers return a typed value or the native validation
error/result. Unknown registration rules and duplicate names are programming
errors. Bad CLI values are parse errors. These are separate error paths.

## Parse without exiting

```javascript
const result = cli.parse(['input.txt', '--port', '443']);
if (result.status === 'ok') console.log(cli.values.PORT);
else if (result.status === 'help') console.log(cli.usage());
else console.error(result.error);
```

`run()` handles help, schema, completion and process exit; `parse()` returns a
native outcome. Read values after success. Parsing resets prior invocation state.
Python/Ruby expose `values`; Rust has `values()`; Go has `Values`; Java has
`values()`. C returns `CLYOPS_OK/HELP/ERROR` and exposes `clyops_error`.
Bash returns zero on success and uses `_CLYOPS_HELP` or `_CLYOPS_ERROR` on failure;
call `clyops_parse` in an `if` when using `set -e`.

## Config files and paths

```javascript
cli.opt('CONFIG', 'config', 'c', 'optional', 'Config file', 'Config', 'path');
cli.setConfig('config', 'send:');
cli.setPathSearch('input', ['assets', 'fixtures']);
```

The last line requires an option named `input` to have been registered. Config is
line-oriented: `send:port=443`, with `@include relative-file` for includes. Prefixes
select the program's keys; unknown keys are errors.

CLI paths resolve against the working directory; config paths resolve against
the config file containing the value; default/environment paths resolve against
the CLI root. Paths are normalized after precedence. `-` denotes stdin where the
application supports it. Path validation does not itself open/read files for the
application. See [spec section 6](../spec/SPEC.md#6-paths).

## Nested commands and constraints

```javascript
const db = cli.command('db', 'Database tasks');
const migrate = db.command('migrate', 'Apply migrations');
migrate.opt('TO', 'to', '', 'optional', 'Target version', 'Options', 'int');
migrate.setEffects('destructive');
cli.opt('JSON', 'json', '', 'flag', 'JSON output');
cli.opt('QUIET', 'quiet', '', 'flag', 'Quiet output');
cli.exclusive('json', 'quiet');
```

Use this recipe on a CLI with no root positionals. Parent options are accepted
before or after command words. `commandPath` gives the selected words, e.g.
`['db', 'migrate']`; use the native accessor listed in the reference.
`exclusive` permits at most one listed option, `requires(a, b...)` means a given
`a` needs the others, and `oneOf` requires at least one. Register referenced
options first. Explicitly false flags do not count as given for relationships.

## Secrets, effects and streams

```javascript
cli.opt('TOKEN', 'token', '', '', 'API token', 'Auth', 'secret');
cli.setEffects('network', 'idempotent');
cli.setStdin('Input document', 'application/json');
cli.setStdout('Result document', 'application/json');
```

`secret` and `secret:RULE` mask help/config previews and `valuesJson()`; the
application still receives the real value. Avoid printing it yourself.
Effects are `read-only`, `idempotent`, `destructive` and `network`.
stdin/stdout declarations describe your program; your code performs the actual
I/O. Schemas carry these declarations for API/MCP/desktop consumers.

## Roles on file descriptors

A program can offer streams beyond stdin, stdout and stderr, such as progress or
metadata, by declaring roles. The runner that starts it decides which it wants and
on which descriptors:

```javascript
cli.role('meta', 'out', 'Transfer metadata, before the output', 'application/json');
cli.role('progress', 'out', 'Progress, one JSON object per line', 'application/x-ndjson');
cli.run();
cli.emit('meta', { name: 'clip.mp4' });
cli.emit('progress', { pct: 50 });
```

The names `meta`, `progress`, `log` and `result` mean the same to every runner;
any other name is free text. Roles show in help (`Output [progress]: …`) and as
`roles` in the schema, on the level they are registered on; commands inherit their
ancestors'.

The runner puts each descriptor at its number before starting the program and
lists the mapping in `CLYOPS_FDS`. Without it, `emit` does nothing, so a program
run by hand needs only stdin, stdout and stderr. To see progress in a terminal:

```sh
CLYOPS_FDS=progress:2 mytool input.wav           # progress on stderr
CLYOPS_FDS=progress:4 mytool input.wav 4>log.ndjson
```

The library reads `CLYOPS_FDS` once and removes it from the environment, so
programs yours starts don't inherit it by accident. To share a stream with one,
keep its descriptor open in the child and set the child's `CLYOPS_FDS` to
`forwardFds('progress')`. Streams of lines (`progress`, `log`) share well; `meta`
and `result` describe one program's output. `fdOpen` returns a role's descriptor
(or none), for reading an `in` role or writing raw bytes.

## Help, schema and shell completion

See [Bash, Zsh and Fish setup](completion.md) for startup files, PATH, sample tools
and completing a whole directory with the dispatcher.

Every standalone program supports `--help`, `--help-json-schema`, and
`--completion bash|zsh|fish`. For example:

```sh
eval "$(mytool --completion bash)"
```

Use `usage`, `jsonSchema`, `completionScript` and `completionData` when embedding
the library. The schema format discriminator is `clyops: 1`. Completion follows
commands and their inherited options. `valuesJson` is a separate resolved-values
document, with secrets masked.

## Logging and helper functions

`info`, `warn`, `error` and `success` write timestamped messages to stderr. `die`
logs and exits with the supplied code. `CLYOPS_SILENT=true` or the native silent
setter suppresses ordinary logging; parse errors and `die` still print.
`NO_COLOR` disables colors. The Node, Go, Java and C helpers support their native
format arguments; Python/Ruby/Rust/Bash receive a rendered message.

Native references also cover rule descriptions, validation, path resolution,
text wrapping and value accessors where those helpers are public.
