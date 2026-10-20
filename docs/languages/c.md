---
title: C
---
# C

Requires **C11 and POSIX**. [Complete API reference](/reference/c/index.html) · [Shared behavior](../guide.md)

## Install and run

```sh
cc -std=c11 -Iinclude quickstart.c -Llib -lclyops -o docs-demo
```

Use the `include` and `lib` directories from the release archive. The source also builds with `cc -std=c11 -Ipackages/c/include quickstart.c packages/c/src/clyops.c -o docs-demo` from a source checkout.

Save the following as `quickstart.c`:

<!-- example: quickstart.c -->
```c
#include "clyops.h"
#include <stdio.h>

int main(int argc, char** argv) {
    clyops_t* cli = clyops_new("docs-demo");
    clyops_opt(cli, "NAME", "name", "World", .short_name = 'n', .description = "Who to greet");
    clyops_opt(cli, "COUNT", "count", "1", .short_name = 'c', .description = "Repeat count", .rule = "int:1-3");
    clyops_opt(cli, "VERBOSE", "verbose", "flag", .short_name = 'v', .description = "Verbose output");
    clyops_run(cli, argc, argv);
    printf("%s %lld %s\n", clyops_get(cli, "NAME"), clyops_get_int(cli, "COUNT"), clyops_get(cli, "VERBOSE"));
    clyops_free(cli);
    return 0;
}
```

```sh
./docs-demo --name Ada --count 2 --verbose
# Ada 2 true
./docs-demo --help
./docs-demo --help-json-schema
./docs-demo --count invalid
# Validation error; exit status 1
```

## Editor support and resolved values

clangd and IDEs read signatures and documentation from `clyops.h`; point the compiler at its include directory and provide a compilation database for your project. Returned value pointers are borrowed. Output helpers return allocated strings that you must free.

## Commands, relationships, secrets, effects and I/O

Add these registrations before calling `run`. A CLI level has either subcommands or positional arguments.

```c
clyops_t* db = clyops_command(cli, "db", "Database tasks");            /* a command: mytool db ... */
clyops_t* migrate = clyops_command(db, "migrate", "Apply migrations");  /* freed with cli */
clyops_opt(migrate, "TO", "to", "optional", .description = "Target version", .rule = "int");
clyops_effects(migrate, "destructive");      /* read-only, idempotent, destructive, network */
clyops_opt(cli, "TOKEN", "token", "", .description = "API token", .rule = "secret"); /* masked in help and values JSON */
clyops_exclusive(cli, "json", "quiet");      /* also clyops_requires(cli, "a", "b"), clyops_one_of(...) */
clyops_stdin(cli, "Audio to transcribe", "audio/wav");  /* and clyops_stdout(cli, description, type) */
clyops_fd(cli, 4, "out", .description = "Progress", .role = "progress");  /* then clyops_emit(cli, "progress", "{...}") */
clyops_run(cli, argc, argv);                 /* clyops_get_at(cli, "command", 0) == "db" */
```

The selected command words are the value `"command"` (`clyops_get_count` / `clyops_get_at`). Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.

## Parsing and errors

Use `clyops_run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `clyops_parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
