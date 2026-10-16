# clyops in Bash

Bash 4.3+ (macOS ships 3.2: `brew install bash`, use `#!/usr/bin/env bash`).
One sourceable file, no dependencies.

## Install

```sh
curl -fsSLo clyops.sh https://raw.githubusercontent.com/wankdanker/clyops/v0.4.0/packages/bash/clyops.sh
```

Pin the release tag the project uses. Source it relative to the script so the
tool works from any directory: `source "$(dirname "${BASH_SOURCE[0]}")/lib/clyops.sh"`.
Sourcing `clyops.sh` is what makes the dispatcher, API and MCP server recognize
the tool.

## Registration

| Call | Arguments |
| --- | --- |
| `clyops_opt` | `VAR long short default description [group] [rule]` |
| `clyops_opt_array` | `VAR long short description [group] [rule]` (`VAR` becomes an array) |
| `clyops_arg` | `NAME description [default] [rule]` |
| `clyops_arg_variadic` | `NAME description [rule]` (`NAME` becomes an array) |
| `clyops_name`, `clyops_description`, `clyops_epilog`, `clyops_root` | text |
| `clyops_config` | `option prefix[,prefix…]` |
| `clyops_path_search` | `long dir[:dir…]` |
| `clyops_require_command` | `command description [install-hint]` |
| `clyops_effects` | `effect...` |
| `clyops_stdin`, `clyops_stdout` | `description content-type` |
| `clyops_exclusive`, `clyops_requires`, `clyops_one_of` | `long long...` |
| `clyops_command` | `"words" description`: later registrations belong to that command |

Use `""` for an empty short name. Quote rules containing shell characters:
`'regex:^[A-Z]{3}$'`, `"choice:a,b"`.

## Values

`clyops_run "$@"` assigns every `VAR` and argument `NAME` as shell variables,
or exits (help, schema, completion, errors). Everything is a string; flags and
`bool` are `true`/`false`; arrays and variadics are Bash arrays (`"${TAG[@]}"`).
The selected command words are `CLYOPS_COMMAND` (an array).

Also: `clyops_source long`, `clyops_is_set long`, `clyops_is_explicitly_set
long`, `clyops_values_json`. Non-exiting: `if clyops_parse "$@"; then …`
(failure sets `$_CLYOPS_HELP` or `$_CLYOPS_ERROR`). Call it in an `if` under
`set -e`.

## Logging

`info`, `warn`, `error`, `success` take a message; `die CODE MESSAGE` logs and
exits.

## Example

```bash
#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/clyops.sh" || exit 1

clyops_name plan
clyops_description "Build a deployment plan. Change nothing."
clyops_opt       SERVICE  service  s api      "Service"                    Options      "choice:api,worker"
clyops_opt       ENV      env      e staging  "Environment"                Options      "choice:staging,production"
clyops_opt       REPLICAS replicas r 2        "Replica count"              Options      "int:1-10"
clyops_opt_array TAG      tag      t          "Labels to attach"           Options      "string:1-40"
clyops_opt       WEBHOOK  webhook  "" optional "Notify this webhook"       Notification url
clyops_opt       EMAIL    email    "" optional "Notify this email address" Notification email
clyops_exclusive webhook email
clyops_effects   read-only
clyops_stdout    "Deployment plan" text/plain
clyops_run "$@"

# Our tool's logic starts here, after the interface is fully declared.
printf 'service=%s env=%s replicas=%s tags=%s\n' "$SERVICE" "$ENV" "$REPLICAS" "${TAG[*]}"
```

## Commands

```bash
clyops_opt     VERBOSE verbose v flag "Verbose output" Global   # program options first
clyops_command db "Database tasks"
clyops_opt     DB_URL url u sqlite:app.db "Database URL" Database
clyops_command "db migrate" "Apply migrations"
clyops_arg     target "Target version" latest
clyops_opt     DRY_RUN dry-run n flag "Show what would run"
clyops_effects destructive
clyops_command "db status" "Show migration status"
clyops_effects read-only
clyops_run "$@"
case "${CLYOPS_COMMAND[*]}" in
    "db migrate") info "migrating to $target" ;;
    "db status")  info "status" ;;
esac
```

A command's registrations are recorded and applied when it is selected, so
sibling commands can reuse option names.
