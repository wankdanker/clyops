# Migrating from whisper.c's `cli.sh` / `cli.js`

clyops keeps the registration model of whisper.c's `scripts/lib/cli.sh` and
`scripts/lib/cli.js`, with the same argument order. Most scripts move over by
renaming functions. These are the differences.

## Bash: renamed functions

| whisper.c `cli.sh` | clyops `clyops.sh` |
| --- | --- |
| `cli_get_opt VAR long short default desc group rule` | `clyops_opt` (same arguments) |
| `cli_get_opt_array` | `clyops_opt_array` |
| `cli_get_arg` / `cli_get_arg_variadic` | `clyops_arg` / `clyops_arg_variadic` |
| `cli_set_description` / `cli_set_epilog` | `clyops_description` / `clyops_epilog` |
| `cli_set_config` | `clyops_config` |
| `cli_set_path_search` | `clyops_path_search` |
| `cli_require_command` | `clyops_require_command` |
| `cli_run` / `cli_parse` | `clyops_run` / `clyops_parse` |
| `cli_is_set` / `cli_is_explicitly_set` | `clyops_is_set` / `clyops_is_explicitly_set` |
| `cli_usage`, `cli_json_schema`, `cli_completion_data` | `clyops_usage`, `clyops_json_schema`, `clyops_completion_data` |
| `PROJECT_ROOT` / `ORIGINAL_DIR` | `clyops_root DIR`; command-line paths resolve against `$PWD` |
| `die`, `error`, `warn`, `info`, `success` | unchanged |

## JavaScript: renamed or removed

* Registration is `opt`, `optArray`, `arg` and `argVariadic`, matching the
  other languages (Python's `opt`/`opt_array`/`arg`/`arg_variadic`). The old
  `getOpt`, `getOptArray`, `getArg` and `getArgVariadic` still work as
  deprecated aliases with the same arguments.
* `setDescription`, `setEpilog`, `setConfig`, `setPathSearch`,
  `requireCommand`, `parse`, `run`, `usage`, `jsonSchema` and
  `completionData` keep their names. The constructor takes
  `{ name, root, cwd, env }`.
* `run()` is synchronous and returns the values (it was `async`).
* `parse()` returns `{ status: 'ok' | 'help' | 'error', … }` instead of a boolean.
* Logging drops the module argument: `info(fmt, …args)` instead of
  `log(module, fmt, …args)`.
* Not carried over (whisper-specific): the `cli` singleton,
  `addCommonOptions`, `loadEnvFile`, `idFromFile`, `requireExec`,
  `parseStringRegex`, `timestamp`.
* `date:YYYY-MM-DD` values stay strings (they were `Date` objects).

## `whspr` → `clyops-dispatch`

Replace the `scripts/whspr` script with a definition file of the same name:

```
#!/usr/bin/env clyops-dispatch
description: whisper.c toolchain
ignore: lib, docx, package
```

`whspr <command>` works as before, and scripts can now be moved into folders, which become groups
(`whspr media to-pcm`). `whspr --list` still prints the command names.
`eval "$(whspr --completion bash)"` (or zsh, fish) replaces `lib/whisper-completion.bash`.
Descriptions come from each script's `--help-json-schema`, so scripts show one once they're on
clyops.

## Behavior changes in both

* **`--help`/`-h` is built in.** It no longer depends on an option whose
  description reads "Show this help message and exit". Registering your own
  `help` option still works and takes precedence. `-h` is left alone if you
  use it for something else.
* **`--ui` interactive mode is not ported**, nor is saving a config from it.
* **Help layout:** groups appear in registration order (they were sorted
  alphabetically), the default width is 100 columns
  (`CLYOPS_MAX_WIDTH`, was `CLI_MAX_WIDTH`/140), and required options are
  marked `required`. On errors, usage goes to stderr.
* **Booleans are stricter.** `--flag=value`, and flag values from config files
  and the environment, must be `true/false/yes/no/1/0/on/off`. A config value
  of `false` now turns a flag off (it was ignored). Values validated by `bool`
  are normalized to `true`/`false`.
* **`--` ends option parsing.**
* **An option literally named `no-something`** is matched before `--no-`
  negation.
* **Config files:** when several prefixes match a line, the first one in the
  list wins (it was the last). Relative paths in config values resolve against
  the directory of the file that contains the line, so `@include`d files work
  as expected (they used the top-level file's directory).
* **Unknown validation rules fail at registration** (they were a warning at
  parse time).
* **Array options keep empty values** (`--tag=` gives `[""]`; JS filtered them).
* **Completion:** `--bash-completion` now starts with `#clyops-completion 1`
  (was `#whspr-completion 2`); the records are otherwise the same, minus the
  hard-coded `--ui` line. `--completion bash|zsh|fish` prints a ready-made
  script, replacing per-project scripts such as `whisper-completion.bash`.
* **JSON schema:** adds `"clyops": 1` and a `required` field per option; drops
  the absolute `path` of the script.
