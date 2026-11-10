/* The conformance demo CLI (spec/conformance/README.md) in C. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "clyops.h"

/* Completers (spec section 9.2): the DEMO_HOSTS entries, then words-N. They fail when DEMO_HOSTS is unset. */
static int demo_hosts(int nwords, void (*each)(const char* value, void* ctx), void* ctx) {
    fputs("completer ran\n", stderr);
    const char* env = getenv("DEMO_HOSTS");
    if (!env) return 1;
    for (const char* p = env;; ) {
        const char* end = strchr(p, ';');
        size_t n = end ? (size_t)(end - p) : strlen(p);
        char* entry = malloc(n + 1);
        if (!entry) return 1;
        memcpy(entry, p, n);
        entry[n] = 0;
        each(entry, ctx);
        free(entry);
        if (!end) break;
        p = end + 1;
    }
    if (nwords > 0) {
        char label[32];
        snprintf(label, sizeof label, "words-%d", nwords);
        each(label, ctx);
    }
    return 0;
}

static void add_value(const char* value, void* ctx) { clyops_values_add(ctx, value); }

/* Library-paged: the library keeps the values starting with the prefix and pages them. */
static int hosts(const clyops_complete_request_t* req, clyops_values_t* out, void* userdata) {
    (void)userdata;
    return demo_hosts(req->nwords, add_value, out);
}

typedef struct {
    const clyops_complete_request_t* req;
    clyops_values_t* out;
    int matched;
    int taken;
} page_t;

static void add_page_value(const char* value, void* ctx) {
    page_t* page = ctx;
    if (strncmp(value, page->req->prefix, strlen(page->req->prefix)) != 0) return;
    if (page->matched++ < page->req->offset) return;
    if (page->req->limit > 0 && page->taken >= page->req->limit) return;
    page->taken++;
    clyops_values_add(page->out, value);
}

/* Paged: applies the request's prefix, offset and limit itself. */
static int paged_hosts(const clyops_complete_request_t* req, clyops_values_t* out, void* userdata) {
    (void)userdata;
    page_t page = {req, out, 0, 0};
    return demo_hosts(req->nwords, add_page_value, &page);
}

int main(int argc, char** argv) {
    clyops_t* cli = clyops_new("demo");
    clyops_root(cli, getenv("DEMO_ROOT"));
    clyops_description(cli, "Demo program for the clyops conformance suite. It registers one of every kind of option and argument so that each implementation can be checked against the same help text, schema and resolved values.");
    clyops_epilog(cli, "Examples:\n  demo in.txt slow a b --tag x --tag y\n  demo in.txt -vc demo.conf");
    clyops_require_command(cli, "sh", "POSIX shell", "install dash");
    clyops_effects(cli, "idempotent", "network");
    clyops_stdin(cli, "Lines to process", "text/plain");
    clyops_stdout(cli, "The resolved values", "application/json");
    clyops_role(cli, "meta", "out", .description = "Run metadata, before the values", .content_type = "application/json");
    clyops_role(cli, "progress", "out", .description = "Progress, one JSON object per line", .content_type = "application/x-ndjson", .schema = "{\"type\":\"object\",\"properties\":{\"pct\":{\"type\":\"number\"}}}");
    clyops_role(cli, "extra", "in", .description = "Extra lines to process", .content_type = "text/plain");

    clyops_arg(cli, "input", .description = "Input file", .rule = "path");
    clyops_arg(cli, "mode", .description = "Processing mode", .default_value = "fast", .rule = "choice:fast,slow");
    clyops_arg_variadic(cli, "rest", .description = "Extra items");

    clyops_opt(cli, "CONFIG",   "config",   "optional",  .short_name = 'c', .description = "Config file to load",   .group = "Config",     .rule = "path");
    clyops_opt(cli, "VERBOSE",  "verbose",  "flag",      .short_name = 'v', .description = "Enable verbose output", .group = "Output");
    clyops_opt(cli, "QUIET",    "quiet",    "flag",      .short_name = 'q', .description = "Suppress output",       .group = "Output");
    clyops_opt(cli, "COLOR",    "color",    "auto",                         .description = "When to use color",     .group = "Output",     .rule = "choice:auto,always,never");
    clyops_opt(cli, "OUT",      "out",      "out.txt",   .short_name = 'o', .description = "Output path",           .group = "Output",     .rule = "path");
    clyops_opt(cli, "NOTES",    "notes",    "optional",                     .description = "Free-form notes. This description is deliberately long so that the help output has to wrap it onto several lines at the default width of one hundred columns.", .group = "Output");
    clyops_opt(cli, "COUNT",    "count",    "3",         .short_name = 'n', .description = "Number of iterations",                         .rule = "int:1-10");
    clyops_opt(cli, "RATIO",    "ratio",    "0.5",                          .description = "Mix ratio",                                    .rule = "float:0-1");
    clyops_opt(cli, "ENABLED",  "enabled",  "true",                         .description = "Enable processing",                            .rule = "bool");
    clyops_opt_array(cli, "TAG", "tag",                  .short_name = 't', .description = "Tag to attach",                                .rule = "string:1-8");
    clyops_opt(cli, "NO_CACHE", "no-cache", "flag",                         .description = "Disable the cache");
    clyops_opt(cli, "KEY",      "key",      "",          .short_name = 'k', .description = "API key",               .group = "Auth",       .rule = "secret");
    clyops_opt(cli, "HOST",     "host",     "localhost", .short_name = 'H', .description = "Server host",           .group = "Network",    .rule = "hostname");
    clyops_opt(cli, "PORT",     "port",     "8080",      .short_name = 'p', .description = "Server port",           .group = "Network",    .rule = "port");
    clyops_opt(cli, "ENDPOINT", "endpoint", "optional",                     .description = "Endpoint URL",          .group = "Network",    .rule = "url");
    clyops_opt(cli, "ADDR",     "addr",     "optional",                     .description = "Bind address",          .group = "Network",    .rule = "ip");
    clyops_opt(cli, "ID",       "id",       "optional",                     .description = "Request identifier",    .group = "Validation", .rule = "uuid");
    clyops_opt(cli, "EMAIL",    "email",    "optional",                     .description = "Contact email",         .group = "Validation", .rule = "email");
    clyops_opt(cli, "DATE",     "date",     "optional",                     .description = "Start date",            .group = "Validation", .rule = "date:YYYY-MM-DD");
    clyops_opt(cli, "CODE",     "code",     "optional",                     .description = "Three-letter code",     .group = "Validation", .rule = "regex:^[A-Z]{3}$");
    clyops_opt(cli, "LEVEL",    "level",    "optional",                     .description = "Level",                 .group = "Validation", .rule = "int");
    clyops_opt(cli, "SIZE",     "size",     "optional",                     .description = "Size code",             .group = "Validation", .rule = "string:4");
    clyops_opt(cli, "PAYLOAD",  "payload",  "optional",                     .description = "JSON payload",          .group = "Validation", .rule = "json");
    clyops_opt(cli, "FILTER",   "filter",   "optional",                     .description = "JSON filter",           .group = "Validation", .rule = "json:{\"type\":\"object\"}");
    clyops_opt(cli, "SHAPE",    "shape",    "optional",                     .description = "JSON shape",            .group = "Validation", .rule = "json:shape.json");
    clyops_opt(cli, "EVENT",    "event",    "optional",                     .description = "JSON event",            .group = "Validation", .rule = "json:https://example.com/event.json");
    clyops_opt(cli, "DATA_DIR", "data-dir", "optional",  .short_name = 'd', .description = "Data directory",        .group = "Files",      .rule = "dir:exists");
    clyops_opt(cli, "SRC",      "src",      "optional",                     .description = "Source file",           .group = "Files",      .rule = "file:exists");
    clyops_opt(cli, "DEST",     "dest",     "optional",                     .description = "Destination file",      .group = "Files",      .rule = "file:writable");
    clyops_opt(cli, "EXEC",     "exec",     "optional",                     .description = "Program to run",        .group = "Files",      .rule = "file:executable");
    clyops_opt_array(cli, "INCLUDE", "include",          .short_name = 'I', .description = "Include directory",     .group = "Files",      .rule = "path");

    clyops_config(cli, "config", "demo:,shared:");
    clyops_path_search(cli, "config", "conf");
    clyops_complete(cli, "host", hosts, NULL);
    clyops_complete_paged(cli, "rest", paged_hosts, NULL);
    clyops_exclusive(cli, "endpoint", "addr");
    clyops_requires(cli, "dest", "src");

    clyops_run(cli, argc, argv);
    clyops_emit(cli, "meta", clyops_fd_open(cli, "extra") >= 0 ? "{\"extra\":true}" : "{\"extra\":false}");
    clyops_emit(cli, "progress", "{\"pct\":100}");

    static const char* longs[] = {"config", "verbose", "quiet", "color", "out", "notes", "count", "ratio", "enabled", "tag",
        "no-cache", "key", "host", "port", "endpoint", "addr", "id", "email", "date", "code", "level", "size", "payload", "filter", "shape", "event", "data-dir",
        "src", "dest", "exec", "include", "help"};
    char* values = clyops_values_json(cli);
    printf("{\"values\": %s, \"sources\": {", values);
    for (size_t i = 0; i < sizeof longs / sizeof *longs; i++)
        printf("%s\"%s\": \"%s\"", i ? ", " : "", longs[i], clyops_source(cli, longs[i]));
    printf("}}\n");
    free(values);
    clyops_free(cli);
    return 0;
}
