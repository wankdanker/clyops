#!/usr/bin/env bash
# Regenerate spec/conformance/golden/* from an implementation (default: js).
# Goldens are the spec: review the diff before committing.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
impl=${1:-js}
read -ra cmd < <(python3 -c "import json,sys; print(' '.join(json.load(open('$here/spec/conformance/impls.json'))[sys.argv[1]]))" "$impl")
[[ ${cmd[1]:-} == packages/* ]] && cmd[1]="$here/${cmd[1]}"
[[ ${cmd[0]} == packages/* ]] && cmd[0]="$here/${cmd[0]}"
golden="$here/spec/conformance/golden"
mkdir -p "$golden"
tmp=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
demo() { (cd "$tmp" && env -i PATH="$PATH" LANG=C.UTF-8 KEY=secret DEMO_ROOT="$tmp" "$@" "${cmd[@]}" "${args[@]}"); }

args=(--help); demo > "$golden/help.txt"
args=(--help); demo CLYOPS_MAX_WIDTH=60 > "$golden/help-60.txt"
printf 'demo:count=5\nshared:host=example.com\n' > "$tmp/demo.conf"
args=(--help -c demo.conf); demo > "$golden/help-config.txt"
args=(--help-json-schema); demo > "$golden/schema.json"
args=(--bash-completion); demo | sed "s|$tmp|{tmp}|g" > "$golden/completion.txt"
echo "wrote goldens from $impl"
