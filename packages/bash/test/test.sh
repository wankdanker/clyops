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

if (( failures )); then echo "$failures failed"; exit 1; fi
echo "all passed"
