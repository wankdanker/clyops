#!/usr/bin/env bash
# clyops-tool
source "$(dirname "${BASH_SOURCE[0]}")/../../packages/bash/clyops.sh" || exit 1

clyops_name upload.sh
clyops_description "Preview an HTTP PUT upload. Add --execute to send the file with curl."
clyops_arg INPUT "File to upload" "" file:readable
clyops_opt URL url u "" "Destination URL" Upload 'regex:^https?://[^ ]+$'
clyops_opt TOKEN token "" optional "Optional bearer token (also read from TOKEN)" Auth secret
clyops_opt TIMEOUT timeout "" 60 "Maximum request duration in seconds" Upload int:1-300
clyops_opt EXECUTE execute "" flag "Send the upload instead of printing the command" Execution
clyops_effects network destructive
clyops_stdout "Command preview or server response" text/plain
clyops_run "$@"
command=(curl --fail --show-error --silent --connect-timeout 5 --max-time "$TIMEOUT" --proto '=http,https' --upload-file "$INPUT" --url "$URL")
if [[ "$EXECUTE" != true ]]; then
    printf '%q ' "${command[@]}"
    if [[ -n "$TOKEN" ]]; then printf '%q ' --header 'Authorization: Bearer <redacted>'; fi
    printf '\n'; exit 0
fi
command -v curl >/dev/null || die 1 "curl is missing; install curl or omit --execute to preview."
if [[ -n "$TOKEN" ]]; then command+=(--header "Authorization: Bearer $TOKEN"); fi
exec "${command[@]}"
