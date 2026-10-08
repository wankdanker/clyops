#!/usr/bin/env bash
# Drive the generated completion scripts in real shells against one
# implementation's demo (default: js). Shells that are not installed are skipped.
#
#   tools/test-completions.sh [impl]
set -uo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
impl=${1:-js}
read -ra cmd < <(python3 -c "import json,sys; print(' '.join(json.load(open('$here/spec/conformance/impls.json'))[sys.argv[1]]))" "$impl")
for i in "${!cmd[@]}"; do [[ ${cmd[i]} == packages/* ]] && cmd[i]="$here/${cmd[i]}"; done

work=$(mktemp -d)
mkdir -p "$work/bin" "$work/root/conf" "$work/root/data"
printf '#!/bin/sh\nexec %s "$@"\n' "$(printf '%q ' "${cmd[@]}")" > "$work/bin/demo"
chmod +x "$work/bin/demo"
touch "$work/root/conf/a.conf" "$work/root/conf/b.conf" "$work/root/in.txt"
export PATH="$work/bin:$PATH" DEMO_ROOT="$work/root"
cd "$work/root" || exit 1

failures=0
check() { # shell line expected actual
    if [[ "$3" == "$4" ]]; then echo "ok - $1: [$2]"; else echo "not ok - $1: [$2] expected [$3], got [$4]"; failures=$((failures + 1)); fi
}

# --- bash: call the completion function the way readline would.
bash_complete() {
    bash --norc --noprofile <<EOF 2>&1
eval "\$(demo --completion bash)"
COMP_WORDS=($1); [[ "$1" == *" " ]] && COMP_WORDS+=(""); COMP_CWORD=\$(( \${#COMP_WORDS[@]} - 1 ))
_clyops_demo
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

# --- fish: complete -C prints what fish would offer.
if command -v fish >/dev/null; then
    fish_complete() {
        fish --no-config <<EOF 2>&1 | cut -f1 | sort | tr '\n' ' '
demo --completion fish | source
complete -C '$1'
EOF
    }
    check fish "demo --col"        "--color "              "$(fish_complete "demo --col")"
    check fish "demo --color "     "always auto never "    "$(fish_complete "demo --color ")"
    check fish "demo in.txt "      "fast slow "            "$(fish_complete "demo in.txt ")"
    check fish "demo --enabled "   "false true "           "$(fish_complete "demo --enabled ")"
    check fish "demo -d "          "conf/ data/ "          "$(fish_complete "demo -d ")"
else
    echo "skip - fish not installed"
fi

# --- zsh: run an interactive zsh in a pseudo-terminal, press TAB and read the listing.
if command -v zsh >/dev/null; then
    cat > "$work/complete.zsh" <<'EOF'
zmodload zsh/zpty
zpty z zsh -f -i
zpty -w z "PATH=$PATH; DEMO_ROOT=$DEMO_ROOT; PS1='> '; autoload -U compinit; compinit -u"
zpty -w z 'eval "$(demo --completion zsh)"'
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
    out=$(zsh_complete "demo --color ")
    for want in always auto never; do
        [[ "$out" == *"$want"* ]] && echo "ok - zsh: [demo --color ] offers $want" || { echo "not ok - zsh: [demo --color ] lacks $want: $out"; failures=$((failures + 1)); }
    done
    out=$(zsh_complete "demo in.txt ")
    for want in fast slow; do
        [[ "$out" == *"$want"* ]] && echo "ok - zsh: [demo in.txt ] offers $want" || { echo "not ok - zsh: [demo in.txt ] lacks $want: $out"; failures=$((failures + 1)); }
    done
    out=$(zsh_complete "demo --ena")
    [[ "$out" == *"--enabled"* ]] && echo "ok - zsh: [demo --ena] offers --enabled" || { echo "not ok - zsh: [demo --ena]: $out"; failures=$((failures + 1)); }
else
    echo "skip - zsh not installed"
fi

if (( failures )); then echo "$failures failed"; exit 1; fi
echo "all passed"
