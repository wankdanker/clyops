#!/usr/bin/env bash
# Drive the generated completion scripts in real shells against one
# implementation's demo (default: js), directly and through a clyops-dispatch
# dispatcher (build apps/dispatch first). Shells that are not installed are skipped.
#
#   tools/test-completions.sh [impl]
set -uo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
impl=${1:-js}
read -ra cmd < <(python3 -c "import json,sys; print(' '.join(json.load(open('$here/spec/conformance/impls.json'))[sys.argv[1]]))" "$impl")
for i in "${!cmd[@]}"; do [[ ${cmd[i]} == packages/* ]] && cmd[i]="$here/${cmd[i]}"; done

work=$(mktemp -d)
mkdir -p "$work/bin" "$work/root/conf" "$work/root/data"
printf '#!/bin/sh\n# clyops-tool\nexec %s "$@"\n' "$(printf '%q ' "${cmd[@]}")" > "$work/bin/demo"
chmod +x "$work/bin/demo"
touch "$work/root/conf/a.conf" "$work/root/conf/b.conf" "$work/root/in.txt"

# A dispatcher "tools" with a plain command and a "media" group holding the demo.
dispatch=$(ls "$here"/apps/dispatch/target/{debug,release}/clyops-dispatch 2>/dev/null | head -1)
[[ -n "$dispatch" ]] || { echo "clyops-dispatch is not built (cargo build in apps/dispatch)"; exit 1; }
mkdir -p "$work/tree/media" "$work/dispatch"
ln -s "$dispatch" "$work/dispatch/clyops-dispatch"
printf '#!/usr/bin/env clyops-dispatch\ndescription: Test tools\n' > "$work/tree/tools"
printf 'description: Media tools\n' > "$work/tree/media/.clyops"
printf '#!/bin/sh\necho hello\n' > "$work/tree/hello"
cp "$work/bin/demo" "$work/tree/media/demo"
chmod +x "$work/tree/tools" "$work/tree/hello" "$work/tree/media/demo"
ln -s "$work/tree/tools" "$work/bin/tools"

export PATH="$work/bin:$work/dispatch:$PATH" DEMO_ROOT="$work/root" XDG_CACHE_HOME="$work/cache"
cd "$work/root" || exit 1

failures=0
check() { # shell line expected actual
    if [[ "$3" == "$4" ]]; then echo "ok - $1: [$2]"; else echo "not ok - $1: [$2] expected [$3], got [$4]"; failures=$((failures + 1)); fi
}

# --- bash: call the completion function the way readline would.
bash_complete() {
    local prog=${1%% *}
    bash --norc --noprofile <<EOF 2>&1
eval "\$($prog --completion bash)"
COMP_WORDS=($1); [[ "$1" == *" " ]] && COMP_WORDS+=(""); COMP_CWORD=\$(( \${#COMP_WORDS[@]} - 1 ))
_clyops_$prog
printf '%s\n' "\${COMPREPLY[@]}" | sort | tr '\n' ' '
EOF
}
check bash "demo --col"         "--color "                 "$(bash_complete "demo --col")"
check bash "demo --color "      "always auto never "       "$(bash_complete "demo --color ")"
check bash "demo -c "           "a.conf b.conf conf data in.txt " "$(bash_complete "demo -c ")"
check bash "demo "              "conf data in.txt "        "$(bash_complete "demo ")"
check bash "demo in.txt "       "fast slow "               "$(bash_complete "demo in.txt ")"
check bash "demo -n 3 in.txt "  "fast slow "               "$(bash_complete "demo -n 3 in.txt ")"
check bash "demo --enabled "    "false true "              "$(bash_complete "demo --enabled ")"
check bash "demo -d "           "conf data "               "$(bash_complete "demo -d ")"
check bash "demo --no-v"        "--no-verbose "            "$(bash_complete "demo --no-v")"
check bash "tools "                        "hello media "            "$(bash_complete "tools ")"
check bash "tools --comp"                  "--completion "           "$(bash_complete "tools --comp")"
check bash "tools media "                  "demo "                   "$(bash_complete "tools media ")"
check bash "tools media demo --col"        "--color "                "$(bash_complete "tools media demo --col")"
check bash "tools media demo --color "     "always auto never "      "$(bash_complete "tools media demo --color ")"
check bash "tools media demo in.txt "      "fast slow "              "$(bash_complete "tools media demo in.txt ")"
check bash "tools media demo -n 3 in.txt " "fast slow "              "$(bash_complete "tools media demo -n 3 in.txt ")"

# --- fish: complete -C prints what fish would offer.
if command -v fish >/dev/null; then
    fish_complete() {
        fish --no-config <<EOF 2>&1 | cut -f1 | sort | tr '\n' ' '
${1%% *} --completion fish | source
complete -C '$1'
EOF
    }
    check fish "demo --col"        "--color "              "$(fish_complete "demo --col")"
    check fish "demo --color "     "always auto never "    "$(fish_complete "demo --color ")"
    check fish "demo in.txt "      "fast slow "            "$(fish_complete "demo in.txt ")"
    check fish "demo --enabled "   "false true "           "$(fish_complete "demo --enabled ")"
    check fish "demo -d "          "conf/ data/ "          "$(fish_complete "demo -d ")"
    check fish "tools "                    "hello media "          "$(fish_complete "tools ")"
    check fish "tools media "              "demo "                 "$(fish_complete "tools media ")"
    check fish "tools media demo --col"    "--color "              "$(fish_complete "tools media demo --col")"
    check fish "tools media demo in.txt "  "fast slow "            "$(fish_complete "tools media demo in.txt ")"
    check fish "tools media demo --color=" "--color=always --color=auto --color=never " "$(fish_complete "tools media demo --color=")"
else
    echo "skip - fish not installed"
fi

# --- zsh: run an interactive zsh in a pseudo-terminal, press TAB and read the listing.
if command -v zsh >/dev/null; then
    cat > "$work/complete.zsh" <<'EOF'
zmodload zsh/zpty
zpty z zsh -f -i
zpty -w z "PATH=$PATH; DEMO_ROOT=$DEMO_ROOT; XDG_CACHE_HOME=$XDG_CACHE_HOME; PS1='> '; autoload -U compinit; compinit -u"
zpty -w z "eval \"\$(${1%% *} --completion zsh)\""
zpty -w z 'print -r -- READY$((1+1))'
zpty -r -m z out '*READY2*'
zpty -n -w z "$1"$'\t'
sleep 2
out=""
while zpty -r -t z chunk; do out+=$chunk; done
print -r -- "${out//$'\e'\[[0-9;?]#[a-zA-Z]/}"
zpty -d z
EOF
    zsh_complete() {
        zsh -f "$work/complete.zsh" "$1" 2>&1 | tr -d '\r\a\017' | tr '\n' ' '
    }
    zsh_offers() { # line words...
        local line=$1 out want
        shift
        out=$(zsh_complete "$line")
        for want in "$@"; do
            if [[ "$out" == *"$want"* ]]; then echo "ok - zsh: [$line] offers $want"
            else echo "not ok - zsh: [$line] lacks $want: $out"; failures=$((failures + 1)); fi
        done
    }
    zsh_offers "demo --color " always auto never
    zsh_offers "demo in.txt " fast slow
    zsh_offers "demo --ena" --enabled
    zsh_offers "tools " hello media "Media tools"
    zsh_offers "tools media " demo
    zsh_offers "tools media demo --color " always auto never
    zsh_offers "tools media demo in.txt " fast slow
else
    echo "skip - zsh not installed"
fi

if (( failures )); then echo "$failures failed"; exit 1; fi
echo "all passed"
