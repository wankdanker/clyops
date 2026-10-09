# clyops (C)

One-line-per-option CLI parsing for C11 on POSIX systems: validation, help text, config files, JSON
schema, logging and shell completion. Two files, no dependencies beyond libc and `<regex.h>`. See the
[main README](https://github.com/wankdanker/clyops).

```c
#include <stdio.h>
#include "clyops.h"

int main(int argc, char** argv) {
    clyops_t* cli = clyops_new(NULL);
    clyops_description(cli, "Copy files to a server.");
    clyops_arg(cli, "SRC", .description = "File to send", .rule = "file:exists");
    clyops_arg_variadic(cli, "EXTRA", .description = "More files", .rule = "file:exists");
    clyops_opt(cli, "HOST", "host", "localhost", .short_name = 'H', .description = "Server", .group = "Network", .rule = "hostname");
    clyops_opt(cli, "PORT", "port", "22", .short_name = 'p', .description = "Port", .group = "Network", .rule = "port");
    clyops_opt(cli, "VERBOSE", "verbose", "flag", .short_name = 'v', .description = "Chatty");
    clyops_opt(cli, "CONFIG", "config", "optional", .short_name = 'c', .description = "Config file", .group = "Config", .rule = "path");
    clyops_config(cli, "config", "send:");
    clyops_run(cli, argc, argv);

    clyops_info("sending %s to %s:%lld", clyops_get(cli, "SRC"), clyops_get(cli, "HOST"), clyops_get_int(cli, "PORT"));
    clyops_free(cli);
    return 0;
}
```

The registration macros wrap their trailing designated initializers in a `clyops_meta_t` compound
literal, so optional fields are named inline and each option stays on one line. The plain
`clyops_add_opt(cli, var, long, default, meta)` functions take a reusable `clyops_meta_t` too.

Values: `clyops_get` (string; flags are `"true"`/`"false"`; `NULL` when unset), `clyops_get_int`,
`clyops_get_double`, `clyops_get_bool`, and `clyops_get_count` / `clyops_get_at` for array options
and variadics. `clyops_parse` is the non-exiting variant of `clyops_run`.

Build with `make` (produces `build/libclyops.a`) or add the directory to a CMake project with
`add_subdirectory(clyops)` and link `clyops`.

## Commands, relationships, secrets, effects and I/O

```c
clyops_t* db = clyops_command(cli, "db", "Database tasks");            /* a command: mytool db ... */
clyops_t* migrate = clyops_command(db, "migrate", "Apply migrations");  /* freed with cli */
clyops_opt(migrate, "TO", "to", "optional", .description = "Target version", .rule = "int");
clyops_effects(migrate, "destructive");      /* read-only, idempotent, destructive, network */
clyops_opt(cli, "TOKEN", "token", "", .description = "API token", .rule = "secret"); /* masked in help and values JSON */
clyops_exclusive(cli, "json", "quiet");      /* also clyops_requires(cli, "a", "b"), clyops_one_of(...) */
clyops_stdin(cli, "Audio to transcribe", "audio/wav");  /* and clyops_stdout(cli, description, type) */
clyops_run(cli, argc, argv);                 /* clyops_get_at(cli, "command", 0) == "db" */
```

The selected command words are the value `"command"` (`clyops_get_count` / `clyops_get_at`). Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.
