#!/usr/bin/env bash
# The conformance commands demo (spec/conformance/README.md) in Bash.
source "$(dirname "${BASH_SOURCE[0]}")/../clyops.sh"

clyops_name tasks
clyops_root "${DEMO_ROOT:-$PWD}"
clyops_description "Commands demo for the clyops conformance suite."
clyops_epilog "Run 'tasks <command> --help' for a command's options."
clyops_opt VERBOSE verbose v flag "Verbose output" Global

clyops_command db "Database tasks"
clyops_opt DB_URL url u sqlite:app.db "Database URL" Database
clyops_command "db migrate" "Apply migrations"
clyops_arg     target "Target version" latest
clyops_opt     DRY_RUN dry-run n flag "Show what would run"
clyops_effects destructive
clyops_command "db status" "Show migration status"
clyops_effects read-only

clyops_command send "Send a message"
clyops_arg     message "Message text"
clyops_opt     WEBHOOK webhook w optional "Webhook URL" Options url
clyops_opt     EMAIL   email   e optional "Email address" Options email
clyops_one_of  webhook email
clyops_effects network
clyops_stdin   "Attachment" application/octet-stream

clyops_run "$@"
printf '{"values": %s}\n' "$(clyops_values_json)"
