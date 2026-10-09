/* The conformance commands demo (spec/conformance/README.md) in C. */
#include <stdio.h>
#include <stdlib.h>

#include "clyops.h"

int main(int argc, char** argv) {
    clyops_t* cli = clyops_new("tasks");
    clyops_root(cli, getenv("DEMO_ROOT"));
    clyops_description(cli, "Commands demo for the clyops conformance suite.");
    clyops_epilog(cli, "Run 'tasks <command> --help' for a command's options.");
    clyops_opt(cli, "VERBOSE", "verbose", "flag", .short_name = 'v', .description = "Verbose output", .group = "Global");

    clyops_t* db = clyops_command(cli, "db", "Database tasks");
    clyops_opt(db, "DB_URL", "url", "sqlite:app.db", .short_name = 'u', .description = "Database URL", .group = "Database");
    clyops_t* migrate = clyops_command(db, "migrate", "Apply migrations");
    clyops_arg(migrate, "target", .description = "Target version", .default_value = "latest");
    clyops_opt(migrate, "DRY_RUN", "dry-run", "flag", .short_name = 'n', .description = "Show what would run");
    clyops_effects(migrate, "destructive");
    clyops_effects(clyops_command(db, "status", "Show migration status"), "read-only");

    clyops_t* send = clyops_command(cli, "send", "Send a message");
    clyops_arg(send, "message", .description = "Message text");
    clyops_opt(send, "WEBHOOK", "webhook", "optional", .short_name = 'w', .description = "Webhook URL", .rule = "url");
    clyops_opt(send, "EMAIL",   "email",   "optional", .short_name = 'e', .description = "Email address", .rule = "email");
    clyops_one_of(send, "webhook", "email");
    clyops_effects(send, "network");
    clyops_stdin(send, "Attachment", "application/octet-stream");

    clyops_run(cli, argc, argv);

    char* values = clyops_values_json(cli);
    printf("{\"values\": %s}\n", values);
    free(values);
    clyops_free(cli);
    return 0;
}
