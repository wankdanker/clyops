# clyops in C

C11 and POSIX; two files (`clyops.h`, `clyops.c`), no dependencies beyond libc
and `<regex.h>`.

## Install

Use `include/` and `lib/` from the release archive:

```sh
cc -std=c11 -Iinclude plan.c -Llib -lclyops -o plan
```

or compile the source directly from a checkout:

```sh
cc -std=c11 -Ipackages/c/include plan.c packages/c/src/clyops.c -o plan
```

Compiled clyops binaries embed their completion header, which is how the
dispatcher, API and MCP server recognize them: no marker comment needed.

## Registration

Optional fields are designated initializers on one line.

```c
clyops_t* cli = clyops_new("plan");
clyops_opt(cli, VAR, long, default, .short_name = 'x', .description = "...", .group = "...", .rule = "...");
clyops_opt_array(cli, VAR, long, .short_name = 'x', .description = "...", .group = "...", .rule = "...");
clyops_arg(cli, NAME, .description = "...", .default_value = "...", .rule = "...");
clyops_arg_variadic(cli, NAME, .description = "...", .rule = "...");
```

Metadata: `clyops_root`, `clyops_description`, `clyops_epilog`,
`clyops_config(cli, option, prefixes)`, `clyops_path_search(cli, long, dirs)`,
`clyops_require_command(cli, cmd, description, hint)`,
`clyops_effects(cli, ...)`, `clyops_stdin(cli, description, type)`,
`clyops_stdout(cli, description, type)`, `clyops_exclusive(cli, ...)`,
`clyops_requires(cli, ...)`, `clyops_one_of(cli, ...)`,
`clyops_command(parent, name, description)` (freed with the root).

## Values

After `clyops_run(cli, argc, argv)`: `clyops_get` (string, borrowed),
`clyops_get_int` (`long long`), `clyops_get_double`, `clyops_get_bool`,
`clyops_get_count` / `clyops_get_at` for arrays, variadics and `"command"` (the
selected command words). Free with `clyops_free(cli)`. `clyops_values_json`
returns an allocated string you must `free`.

Also `clyops_source`, and non-exiting `clyops_parse` returning
`CLYOPS_OK` / `CLYOPS_HELP` / `CLYOPS_ERROR` (message in `clyops_error(cli)`).

## Logging

printf-style: `clyops_info`, `clyops_warn`, `clyops_errorf` (**not**
`clyops_error`, which reads the parse error), `clyops_success`,
`clyops_die(code, fmt, ...)`; `clyops_set_silent(1)`.

## Example

```c
#include <stdio.h>

#include "clyops.h"

int main(int argc, char** argv) {
    clyops_t* cli = clyops_new("plan");
    clyops_description(cli, "Build a deployment plan. Change nothing.");
    clyops_opt(cli, "SERVICE", "service", "api", .short_name = 's', .description = "Service", .rule = "choice:api,worker");
    clyops_opt(cli, "ENV", "env", "staging", .short_name = 'e', .description = "Environment", .rule = "choice:staging,production");
    clyops_opt(cli, "REPLICAS", "replicas", "2", .short_name = 'r', .description = "Replica count", .rule = "int:1-10");
    clyops_opt_array(cli, "TAG", "tag", .short_name = 't', .description = "Labels to attach", .rule = "string:1-40");
    clyops_opt(cli, "WEBHOOK", "webhook", "optional", .description = "Notify this webhook", .group = "Notification", .rule = "url");
    clyops_opt(cli, "EMAIL", "email", "optional", .description = "Notify this email address", .group = "Notification", .rule = "email");
    clyops_exclusive(cli, "webhook", "email");
    clyops_effects(cli, "read-only");
    clyops_stdout(cli, "Deployment plan", "text/plain");
    clyops_run(cli, argc, argv);

    /* Our tool's logic starts here, after the interface is fully declared. */
    printf("service=%s env=%s replicas=%lld tags=", clyops_get(cli, "SERVICE"), clyops_get(cli, "ENV"),
           clyops_get_int(cli, "REPLICAS"));
    for (size_t i = 0; i < clyops_get_count(cli, "TAG"); i++)
        printf("%s%s", i ? "," : "", clyops_get_at(cli, "TAG", i));
    printf("\n");
    clyops_free(cli);
    return 0;
}
```

## Commands

```c
clyops_opt(cli, "VERBOSE", "verbose", "flag", .short_name = 'v', .description = "Verbose output", .group = "Global");
clyops_t* db = clyops_command(cli, "db", "Database tasks");
clyops_opt(db, "DB_URL", "url", "sqlite:app.db", .short_name = 'u', .description = "Database URL", .group = "Database");
clyops_t* migrate = clyops_command(db, "migrate", "Apply migrations");
clyops_arg(migrate, "target", .description = "Target version", .default_value = "latest");
clyops_opt(migrate, "DRY_RUN", "dry-run", "flag", .short_name = 'n', .description = "Show what would run");
clyops_effects(migrate, "destructive");
clyops_effects(clyops_command(db, "status", "Show migration status"), "read-only");
clyops_run(cli, argc, argv);
/* clyops_get_at(cli, "command", 0) is "db", index 1 is "migrate" */
```
