# clyops (Bash)

One-line-per-option CLI parsing for Bash 4.3+ in a single sourceable file: validation, help text,
config files, JSON schema, logging and shell completion. See the
[main README](https://github.com/wankdanker/clyops).

```bash
#!/usr/bin/env bash
source clyops.sh

clyops_description "Copy files to a server."
clyops_arg          SRC   "File to send" "" "file:exists"
clyops_arg_variadic EXTRA "More files" "file:exists"
clyops_opt  HOST    host    H localhost "Server"  Network hostname
clyops_opt  PORT    port    p 22        "Port"    Network port
clyops_opt  VERBOSE verbose v flag      "Chatty"
clyops_opt  CONFIG  config  c optional  "Config file" Config path
clyops_config config "send:"
clyops_run "$@"

info "sending $SRC to $HOST:$PORT"
```

Registration:

| Function | Arguments |
| --- | --- |
| `clyops_opt` | `VAR long short default description [group] [rule]` — default is a value, `flag`, `optional`, or `""` (required) |
| `clyops_opt_array` | `VAR long short description [group] [rule]` — `VAR` becomes an array |
| `clyops_arg` | `NAME description [default] [rule]` |
| `clyops_arg_variadic` | `NAME description [rule]` — `NAME` becomes an array |
| `clyops_description`, `clyops_epilog`, `clyops_name`, `clyops_root` | text |
| `clyops_config` | `option prefix[,prefix…]` |
| `clyops_path_search` | `long dir[:dir…]` |
| `clyops_require_command` | `command description [install-hint]` |

`clyops_run "$@"` parses and assigns the variables, exiting on `--help` or errors.
`clyops_parse "$@"` does not exit: it returns non-zero and sets `$_CLYOPS_HELP` or
`$_CLYOPS_ERROR`. Also: `clyops_source`, `clyops_is_set`, `clyops_is_explicitly_set`, `clyops_usage`,
`clyops_json_schema`, `clyops_completion_script`, `clyops_values_json`, and the logging helpers
`info`, `warn`, `error`, `success`, `die <code> <message>`.

The environment variable named after an option's `VAR` is read when the option is registered, so
`PORT=8080 ./send a.txt` works. Flags and `bool` options become `true`/`false`.

macOS ships Bash 3.2; install a current Bash (`brew install bash`) and use `#!/usr/bin/env bash`.

## Commands, relationships, secrets, effects and I/O

```bash
clyops_opt     TOKEN token t "" "API token" Auth secret   # masked in help and clyops_values_json
clyops_exclusive json quiet                               # also clyops_requires a b..., clyops_one_of a b...
clyops_stdin   "Audio to transcribe" audio/wav            # and clyops_stdout description content-type
clyops_effects read-only                                  # read-only, idempotent, destructive, network
clyops_command db "Database tasks"                        # later registrations belong to db...
clyops_command "db migrate" "Apply migrations"            # ...then to db migrate
clyops_opt     TO to "" optional "Target version" Options int
clyops_run "$@"                                           # CLYOPS_COMMAND=(db migrate)
```

A command's registrations are recorded and made when the command is selected, so sibling commands can reuse option names; register the program's own options before its commands. Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.
