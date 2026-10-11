#!/usr/bin/env bash
# clyops-tool
source "$(dirname "${BASH_SOURCE[0]}")/../../packages/bash/clyops.sh" || exit 1

clyops_name media-info.sh
clyops_description "Inspect a media file with ffprobe. Install FFmpeg to run; help works without it."
clyops_arg INPUT "Media file to inspect" "" file:readable
clyops_opt FORMAT format f json "Output format" Output choice:json,text
clyops_effects read-only
clyops_stdout "Media metadata" text/plain
clyops_run "$@"
command -v ffprobe >/dev/null || die 1 "ffprobe is missing; install FFmpeg to inspect media."
if [[ "$FORMAT" == json ]]; then
    exec ffprobe -v error -show_format -show_streams -of json -- "$INPUT"
else
    exec ffprobe -v error -show_format -show_streams -- "$INPUT"
fi
