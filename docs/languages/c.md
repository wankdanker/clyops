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
clyops_role(cli, "progress", "out", .description = "Progress");  /* then clyops_emit(cli, "progress", "{...}") */
clyops_run(cli, argc, argv);                 /* clyops_get_at(cli, "command", 0) == "db" */
```

The selected command words are the value `"command"` (`clyops_get_count` / `clyops_get_at`). Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.

## Completion values from your program

`clyops_complete(cli, name, fn, userdata)` lists the values of a value option,
array option or positional argument of that level, for values only the program
can find, such as the instances registered in a directory. They are offered
when the user presses Tab, and tooling (the HTTP API, MCP server and web runner)
reads them with `--complete-values`:

```c
#include <dirent.h>
#include <string.h>

/* Instance names: the *.json files in the directory given as userdata. */
static int instances(const clyops_complete_request_t* req, clyops_values_t* out, void* dir) {
    (void)req;                                           /* the library applies the prefix and pages */
    DIR* d = opendir(dir);
    if (!d) return 1;                                    /* non-zero keeps the rule's completion */
    for (struct dirent* e; (e = readdir(d));) {
        size_t n = strlen(e->d_name);
        if (n <= 5 || strcmp(e->d_name + n - 5, ".json") != 0) continue;
        char name[256];
        snprintf(name, sizeof name, "%.*s", (int)(n - 5), e->d_name);
        clyops_values_add(out, name);                    /* copied */
    }
    closedir(d);
    return 0;
}

/* in main, with the other registrations: */
clyops_opt(cli, "INSTANCE", "instance", "", .short_name = 'i', .description = "Instance to target");
clyops_complete(cli, "instance", instances, "/var/lib/myapp/instances");
```

The function (`clyops_completer_t`) gets a `clyops_complete_request_t`:
`words` (`nwords` of them, the words typed after the command words, for
completers that depend on another option), `prefix` (the text being completed),
`limit` and `offset`. It runs only for `--bash-completion` and
`--complete-values`, so keep it quick and don't write to stdout. It adds values
with `clyops_values_add` and returns 0; a non-zero return keeps the rule's
completion. The library drops empty values and duplicates, keeps the values
starting with `prefix`, then skips `offset` and keeps `limit`, so the function
may add every value. It doesn't validate: check the value after `clyops_run`
if only listed values are allowed. Completing an unknown name or a flag prints
an error and exits with status 2; registering a name again replaces its
completer.

When the values come from a database, register with `clyops_complete_paged`
and apply the request yourself. The function is then asked for one more value
than wanted (`limit` is never 0 here), so the library can tell whether more
remain:

```c
#define CUSTOMERS_SQL "SELECT name FROM customers WHERE name LIKE ?1 || '%' ORDER BY name LIMIT ?2 OFFSET ?3"

static int customers(const clyops_complete_request_t* req, clyops_values_t* out, void* db) {
    sqlite3_stmt* st;
    if (sqlite3_prepare_v2(db, CUSTOMERS_SQL, -1, &st, NULL) != SQLITE_OK) return 1;
    sqlite3_bind_text(st, 1, req->prefix, -1, SQLITE_STATIC);
    sqlite3_bind_int(st, 2, req->limit);
    sqlite3_bind_int(st, 3, req->offset);
    while (sqlite3_step(st) == SQLITE_ROW) clyops_values_add(out, (const char*)sqlite3_column_text(st, 0));
    sqlite3_finalize(st);
    return 0;
}

clyops_complete_paged(cli, "customer", customers, db);
```

`prog --complete-values NAME PREFIX LIMIT OFFSET -- WORDS...` prints one page
as JSON, `{"values":[...],"more":false}`, and exits; values with spaces or
commas are kept there, while shell completion drops them and asks for at most
1000. In code, `clyops_complete_values(cli, name, prefix, limit, offset, nwords,
words, &page)` fills a `clyops_values_page_t` (`values`, `count`, `more`; free
it with `clyops_values_page_free`) and returns 0, or -1 with `clyops_error`
holding `No completer for 'NAME'` or `Completer for 'NAME' failed`. See the
[spec](../../spec/SPEC.md) sections 9.2 and 9.3.

## Parsing and errors

Use `clyops_run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `clyops_parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
