#!/usr/bin/env bash
source "${CLYOPS_LIBRARY:-./clyops.sh}"
clyops_name docs-demo
clyops_opt NAME name n World "Who to greet"
clyops_opt COUNT count c 1 "Repeat count" Options int:1-3
clyops_opt VERBOSE verbose v flag "Verbose output"
clyops_run "$@"
printf '%s %s %s\n' "$NAME" "$COUNT" "$VERBOSE"
