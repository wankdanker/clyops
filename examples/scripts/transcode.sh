#!/usr/bin/env bash
# clyops-tool
source "$(dirname "${BASH_SOURCE[0]}")/../../packages/bash/clyops.sh" || exit 1

clyops_name transcode.sh
clyops_description "Preview an H.264/AAC conversion. Add --execute to write the output with FFmpeg."
clyops_arg INPUT "Source media file" "" file:readable
clyops_arg OUTPUT "Destination media file (never overwritten)" "" path
clyops_opt QUALITY quality q 23 "H.264 CRF (lower means higher quality)" Encoding int:0-51
clyops_opt PRESET preset p medium "Encoder speed" Encoding choice:fast,medium,slow
clyops_opt EXECUTE execute "" flag "Run the conversion instead of printing the command" Execution
clyops_effects destructive
clyops_stdout "Command preview or FFmpeg output" text/plain
clyops_run "$@"
command=(ffmpeg -nostdin -n -i "$INPUT" -c:v libx264 -crf "$QUALITY" -preset "$PRESET" -c:a aac "$OUTPUT")
if [[ "$EXECUTE" != true ]]; then
    printf '%q ' "${command[@]}"; printf '\n'
    exit 0
fi
command -v ffmpeg >/dev/null || die 1 "ffmpeg is missing; install FFmpeg or omit --execute to preview."
exec "${command[@]}"
