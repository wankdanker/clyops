#!/usr/bin/env bash
# Unit tests for clyops.sh that the shared conformance suite cannot see:
# caller variables, arrays, set -euo pipefail, and the non-exiting parse.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
failures=0

check() { # description expected actual
    if [[ "$2" == "$3" ]]; then echo "ok - $1"; else echo "not ok - $1: expected [$2], got [$3]"; failures=$((failures + 1)); fi
}

# Each scenario runs in a fresh bash so registrations don't leak between them.
run() { bash -c "set -euo pipefail; source '$here/../clyops.sh'; $1" _ "${@:2}" 2>&1; }

check "scalars, flags and arrays land in caller variables" "in.txt|5|true|a b|x y z" "$(run '
    clyops_arg FILE "File"
    clyops_arg_variadic REST "Rest"
    clyops_opt COUNT count n 1 "Count" Options int
    clyops_opt FAST fast f flag "Fast"
    clyops_opt_array TAG tag t "Tags"
    clyops_run "$@"
    echo "$FILE|$COUNT|$FAST|${TAG[*]}|${REST[*]}"' in.txt -fn5 -t a -t b x y z)"

check "variables named like library locals are not shadowed" "1|2|3" "$(run '
    clyops_opt long long "" 1 "x"
    clyops_opt opt opt "" 2 "x"
    clyops_opt i i "" 3 "x"
    clyops_run
    echo "$long|$opt|$i"')"

check "bool rule normalizes to true/false" "false" "$(run '
    clyops_opt ON on "" yes "x" Options bool
    clyops_run --on off
    echo "$ON"')"

check "optional unset option is empty under set -u" "[]" "$(run '
    clyops_opt MAYBE maybe "" optional "x"
    clyops_run
    echo "[$MAYBE]"')"

check "clyops_parse reports errors without exiting" "rc=1 err=Unknown option: --nope" "$(run '
    clyops_opt A a "" 1 "x"
    rc=0; clyops_parse --nope || rc=$?
    echo "rc=$rc err=$_CLYOPS_ERROR"')"

check "clyops_parse flags help" "help=1" "$(run '
    rc=0; clyops_parse -h || rc=$?
    echo "help=$_CLYOPS_HELP"')"

check "environment captured at registration" "7|env" "$(COUNT=7 run '
    clyops_opt COUNT count "" 1 "x" Options int
    clyops_run
    echo "$COUNT|$(clyops_source count)"')"

check "is_set and is_explicitly_set" "yes no yes" "$(COUNT=7 run '
    clyops_opt COUNT count "" 1 "x"
    clyops_opt V v "" flag "x"
    clyops_opt W w "" flag "x"
    clyops_run --v
    a=no b=no c=no
    clyops_is_set v && a=yes
    clyops_is_set count && b=yes
    clyops_is_explicitly_set count && c=yes
    echo "$a $b $c"')"

check "unknown rule is a registration error" "Unknown validation rule 'nope' for --a" "$(run '
    clyops_opt A a "" 1 "x" Options nope' | sed 's/.*\] //')"

check "logging honors CLYOPS_SILENT except die" "[error] boom" "$(CLYOPS_SILENT=true run '
    info hidden; warn hidden; error hidden
    die 3 boom' | sed 's/^[0-9: -]* //')"

check "secret values are masked in values JSON but not in variables" "hunter2|***" "$(run '
    clyops_opt TOKEN token "" "" "Token" Auth "secret:string:3-"
    clyops_run "$@"
    printf "%s|%s\n" "$TOKEN" "$(clyops_values_json | sed -n "s/.*\"TOKEN\": \"\(.*\)\".*/\1/p")"' --token hunter2)"

check "relationships" "Options --a and --b cannot be used together" "$(run '
    clyops_opt A a a flag "A"; clyops_opt B b b flag "B"
    clyops_exclusive a b
    clyops_parse -ab || echo "$_CLYOPS_ERROR"')"

check "unknown effect is a registration error" "Unknown effect 'sideways'" "$(run '
    clyops_effects sideways' | sed 's/.*\] //')"

check "commands set CLYOPS_COMMAND and the chain's variables" "db migrate|3|x|latest" "$(run '
    clyops_opt CONFIG config c optional "Config" Global
    clyops_command db "Database"
    clyops_command "db migrate" "Migrate"
    clyops_opt TO to "" optional "Target" Options int
    clyops_arg NAME "Name" latest
    clyops_run "$@"
    echo "${CLYOPS_COMMAND[*]}|$TO|$CONFIG|$NAME"' db -c x migrate --to 3)"

check "sibling commands may reuse option names" "seed|5" "$(run '
    clyops_command migrate "Migrate"; clyops_opt TO to "" optional "Target" Options int
    clyops_command seed "Seed"; clyops_opt TO to "" 1 "Rows" Options int
    clyops_run "$@"
    echo "${CLYOPS_COMMAND[*]}|$TO"' seed --to 5)"

check "commands and positional arguments do not mix" "Cannot mix commands and positional arguments" "$(run '
    clyops_arg X "X"; clyops_command c "C"' | sed 's/.*\] //')"

check "fd registration errors" "Invalid file descriptor 2|Unknown fd direction 'both'|Invalid fd role '7'|Duplicate file descriptor 3|Duplicate fd role 'log'" "$(
    for reg in 'clyops_fd 2 out X' 'clyops_fd 3 both X' 'clyops_fd 3 out X "" 7' \
        'clyops_fd 3 out X; clyops_fd 3 in Y' 'clyops_fd 3 out X "" log; clyops_fd 4 out Y "" log'; do
        run "$reg" | sed 's/.*\] //'
    done | paste -sd'|')"

check "fd emit writes only to descriptors listed in CLYOPS_FDS" '{"pct":50}|plain|ends' "$(
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
    CLYOPS_FDS="7, 9" run '
        clyops_fd 7 out "Progress" "" progress; clyops_fd 8 out "Unlisted" "" log; clyops_fd 9 in "Extra"
        clyops_run
        clyops_emit progress "{\"pct\":50}"; clyops_emit 7 plain; clyops_emit progress $'"'"'ends\n'"'"'
        clyops_emit log "never"
        clyops_fd_open 9 || echo "9 closed" >&2' 7>"$tmp" 8>>"$tmp" >/dev/null
    paste -sd'|' "$tmp"
    )"

check "fd emit to an undeclared role or an input is a programming error" "No file descriptor declared for 'nope'|File descriptor 9 is not an output" "$({
    run 'clyops_fd 9 in X; clyops_run; clyops_emit nope x' | sed 's/.*\] //'
    run 'clyops_fd 9 in X; clyops_run; clyops_emit 9 x' | sed 's/.*\] //'; } | paste -sd'|')"

check "fd lookup: commands inherit, nearest wins, help lists their own" "3|4|Output fd 4 [progress]: Migration progress|0" "$({ CLYOPS_FDS=3,4 run '
    clyops_fd 3 out "Progress" "" progress
    clyops_command db "Database"; clyops_command "db migrate" "Migrate"; clyops_fd 4 out "Migration progress" "" progress
    clyops_command "db status" "Status"
    clyops_run "$@"
    clyops_fd_open progress' db status 3>/dev/null 4>/dev/null
    CLYOPS_FDS=3,4 run '
    clyops_fd 3 out "Progress" "" progress
    clyops_command db "Database"; clyops_command "db migrate" "Migrate"; clyops_fd 4 out "Migration progress" "" progress
    clyops_run "$@"; clyops_fd_open progress
    clyops_usage | grep "fd"; clyops_usage | grep -c "fd 3" || true' db migrate 3>/dev/null 4>/dev/null; } | paste -sd'|')"

if (( failures )); then echo "$failures failed"; exit 1; fi
echo "all passed"
