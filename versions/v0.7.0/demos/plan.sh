#!/usr/bin/env bash
source "${CLYOPS_LIBRARY:-./clyops.sh}"

clyops_name plan
clyops_description "Build a deployment plan. Change nothing."
clyops_opt SERVICE service s api "Service" Options choice:api,worker
clyops_opt ENV env e staging "Environment" Options choice:staging,production
clyops_opt REPLICAS replicas r 2 "Replica count" Options int:1-10
clyops_effects read-only
clyops_stdout "Deployment plan" application/json
clyops_run "$@"
printf '{"service":"%s","env":"%s","replicas":%s}\n' "$SERVICE" "$ENV" "$REPLICAS"
