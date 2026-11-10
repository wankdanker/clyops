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
clyops_role(cli, "progress", "out", .description = "Progress");  /* then clyops_emit(cli, "progress", "{...}") */
clyops_run(cli, argc, argv);                 /* clyops_get_at(cli, "command", 0) == "db" */
```

The selected command words are the value `"command"` (`clyops_get_count` / `clyops_get_at`). Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](https://github.com/wankdanker/clyops/blob/main/spec/SPEC.md) sections 1.3 to 1.7.

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
[spec](https://github.com/wankdanker/clyops/blob/main/spec/SPEC.md) sections 9.2 and 9.3.

## Documentation

Read the [language guide](https://clyops.io/languages/c.html)
for installation, examples and editor setup, and the
[complete API reference](https://clyops.io/reference.html)
for public signatures, return values and errors. The
[Markdown sources](https://github.com/wankdanker/clyops/tree/main/docs/languages)
are also readable on GitHub.
