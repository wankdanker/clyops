/* The conformance commands demo (spec/conformance/README.md) in C. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "clyops.h"

/* Completers (spec section 9.2). */
static int urls(const char* const* words, int nwords, clyops_values_t* out, void* userdata) {
    (void)words;
    (void)nwords;
    (void)userdata;
    clyops_values_add(out, "sqlite:app.db");
    clyops_values_add(out, "pg:main");
    return 0;
}

static int targets(const char* const* words, int nwords, clyops_values_t* out, void* userdata) {
    (void)userdata;
    clyops_values_add(out, "v1");
    clyops_values_add(out, "v2");
    for (int i = 0; i < nwords; i++) {
        size_t n = strlen(words[i]) + 3;
        char* label = malloc(n);
        if (!label) return 1;
        snprintf(label, n, "w:%s", words[i]);
        clyops_values_add(out, label);
        free(label);
    }
    return 0;
}

int main(int argc, char** argv) {
    clyops_t* cli = clyops_new("tasks");
    clyops_root(cli, getenv("DEMO_ROOT"));
    clyops_description(cli, "Commands demo for the clyops conformance suite.");
    clyops_epilog(cli, "Run 'tasks <command> --help' for a command's options.");
    clyops_opt(cli, "VERBOSE", "verbose", "flag", .short_name = 'v', .description = "Verbose output", .group = "Global");
    clyops_role(cli, "progress", "out", .description = "Progress, one JSON object per line", .content_type = "application/x-ndjson");

    clyops_t* db = clyops_command(cli, "db", "Database tasks");
    clyops_opt(db, "DB_URL", "url", "sqlite:app.db", .short_name = 'u', .description = "Database URL", .group = "Database");
    clyops_complete(db, "url", urls, NULL);
    clyops_t* migrate = clyops_command(db, "migrate", "Apply migrations");
    clyops_arg(migrate, "target", .description = "Target version", .default_value = "latest");
    clyops_opt(migrate, "DRY_RUN", "dry-run", "flag", .short_name = 'n', .description = "Show what would run");
    clyops_complete(migrate, "target", targets, NULL);
    clyops_effects(migrate, "destructive");
    clyops_role(migrate, "plan", "out", .description = "Migration plan", .content_type = "text/plain");
    clyops_effects(clyops_command(db, "status", "Show migration status"), "read-only");

    clyops_t* send = clyops_command(cli, "send", "Send a message");
    clyops_arg(send, "message", .description = "Message text");
    clyops_opt(send, "WEBHOOK", "webhook", "optional", .short_name = 'w', .description = "Webhook URL", .rule = "url");
    clyops_opt(send, "EMAIL",   "email",   "optional", .short_name = 'e', .description = "Email address", .rule = "email");
    clyops_one_of(send, "webhook", "email");
    clyops_effects(send, "network");
    clyops_stdin(send, "Attachment", "application/octet-stream");

    clyops_run(cli, argc, argv);
    clyops_emit(cli, "progress", "{\"stage\":\"done\"}");

    char* values = clyops_values_json(cli);
    printf("{\"values\": %s}\n", values);
    free(values);
    clyops_free(cli);
    return 0;
}
