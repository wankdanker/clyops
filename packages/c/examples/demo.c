/* The conformance demo CLI (spec/conformance/README.md) in C. */
#include <stdio.h>
#include <stdlib.h>

#include "clyops.h"

int main(int argc, char** argv) {
    clyops_t* cli = clyops_new("demo");
    clyops_root(cli, getenv("DEMO_ROOT"));
    clyops_description(cli, "Demo program for the clyops conformance suite. It registers one of every kind of option and argument so that each implementation can be checked against the same help text, schema and resolved values.");
    clyops_epilog(cli, "Examples:\n  demo in.txt slow a b --tag x --tag y\n  demo in.txt -vc demo.conf");
    clyops_require_command(cli, "sh", "POSIX shell", "install dash");

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
    clyops_opt(cli, "KEY",      "key",      "",          .short_name = 'k', .description = "API key",               .group = "Auth");
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
    clyops_opt(cli, "DATA_DIR", "data-dir", "optional",  .short_name = 'd', .description = "Data directory",        .group = "Files",      .rule = "dir:exists");
    clyops_opt(cli, "SRC",      "src",      "optional",                     .description = "Source file",           .group = "Files",      .rule = "file:exists");
    clyops_opt(cli, "DEST",     "dest",     "optional",                     .description = "Destination file",      .group = "Files",      .rule = "file:writable");
    clyops_opt_array(cli, "INCLUDE", "include",          .short_name = 'I', .description = "Include directory",     .group = "Files",      .rule = "path");

    clyops_config(cli, "config", "demo:,shared:");
    clyops_path_search(cli, "config", "conf");

    clyops_run(cli, argc, argv);

    static const char* longs[] = {"config", "verbose", "quiet", "color", "out", "notes", "count", "ratio", "enabled", "tag",
        "no-cache", "key", "host", "port", "endpoint", "addr", "id", "email", "date", "code", "level", "size", "data-dir",
        "src", "dest", "include", "help"};
    char* values = clyops_values_json(cli);
    printf("{\"values\": %s, \"sources\": {", values);
    for (size_t i = 0; i < sizeof longs / sizeof *longs; i++)
        printf("%s\"%s\": \"%s\"", i ? ", " : "", longs[i], clyops_source(cli, longs[i]));
    printf("}}\n");
    free(values);
    clyops_free(cli);
    return 0;
}
