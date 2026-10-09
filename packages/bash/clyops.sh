#!/usr/bin/env bash
# clyops — declarative CLI parsing for Bash (4.3+). Behavior follows spec/SPEC.md.
#
#   source clyops.sh
#   clyops_description "Do the thing"
#   clyops_arg  INPUT "Input file" "" path
#   clyops_opt  PORT port p 8080 "Server port" Network port
#   clyops_opt  VERBOSE verbose v flag "Verbose output"
#   clyops_run "$@"
#   echo "$INPUT $PORT $VERBOSE"
#
# Internal state lives in _CLYOPS_* globals; locals in functions that assign
# caller variables are prefixed with _c_ so they cannot shadow them.
#
# SC2178: _c_list is a nameref to a per-option list array, not a string.
# shellcheck disable=SC2178

if [[ -n "${_CLYOPS_LOADED:-}" ]]; then return 0; fi
_CLYOPS_LOADED=1
# shellcheck disable=SC2034  # public: read by callers
CLYOPS_VERSION="0.2.0"

if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3) )); then
    echo "clyops.sh requires bash 4.3 or newer (found $BASH_VERSION)" >&2
    return 1 2>/dev/null || exit 1
fi

_CLYOPS_NAME=""
_CLYOPS_ROOT=""
_CLYOPS_DESCRIPTION=""
_CLYOPS_EPILOG=""
_CLYOPS_CONFIG_OPT=""
_CLYOPS_CONFIG_PREFIXES=()

_CLYOPS_OPTS=()                 # long names in registration order
declare -A _CLYOPS_VAR=() _CLYOPS_SHORT=() _CLYOPS_BYSHORT=() _CLYOPS_KIND=() _CLYOPS_DEFAULT=()
declare -A _CLYOPS_REQUIRED=() _CLYOPS_DESC=() _CLYOPS_GROUP=() _CLYOPS_RULE=() _CLYOPS_SEARCH=()
declare -A _CLYOPS_ENV=()       # environment value captured at registration (non-empty only)
declare -A _CLYOPS_INDEX=()     # long -> registration index (names the per-option list array)

_CLYOPS_ARGS=() _CLYOPS_ARG_DESC=() _CLYOPS_ARG_DEFAULT=() _CLYOPS_ARG_RULE=()
_CLYOPS_VARIADIC=""             # index of the variadic argument, if any

_CLYOPS_CMDS=() _CLYOPS_CMD_DESC=() _CLYOPS_CMD_HINT=() _CLYOPS_CMD_OWNER=()
declare -A _CLYOPS_SECRET=()    # long -> 1 for secret options
declare -A _CLYOPS_OWNER=()     # long -> the command that registered it ("" for the program)
_CLYOPS_EFFECTS=()
_CLYOPS_STDIN=() _CLYOPS_STDOUT=()   # (description content-type) when declared
_CLYOPS_CON_TYPE=() _CLYOPS_CON_OPTS=() _CLYOPS_CON_OWNER=()   # option relationships

# Commands (spec section 1.7). Registrations made after clyops_command are
# recorded, and replayed when the command is selected, so sibling commands
# can reuse option names. Keys are ":" plus the command words.
_CLYOPS_CUR=""                  # command being registered
_CLYOPS_SEL=""                  # command selected so far
_CLYOPS_REPLAYING=""
declare -A _CLYOPS_CMD_REC=() _CLYOPS_CMD_ABOUT=() _CLYOPS_CMD_KIDS=() _CLYOPS_CMD_HASARGS=() _CLYOPS_ENTERED=()
# shellcheck disable=SC2034  # public: the selected command words after parsing
CLYOPS_COMMAND=()

# Per-parse state
declare -A _CLYOPS_RAW=() _CLYOPS_HAS=() _CLYOPS_SRC=() _CLYOPS_CFG_VAL=() _CLYOPS_CFG_DIR=()
_CLYOPS_ARGV=() _CLYOPS_REST=()
_CLYOPS_ERROR="" _CLYOPS_DETAIL=() _CLYOPS_SHOW_USAGE=1 _CLYOPS_HELP=""
_r=""                           # return slot for helpers (avoids subshells)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_clyops_log() {
    local level="$1" msg="$2" force="${3:-}" color="" reset=""
    [[ -z "$force" && "${CLYOPS_SILENT:-}" == "true" ]] && return 0
    if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
        case "$level" in
            info) color=$'\033[1;37m' ;; warning) color=$'\033[0;33m' ;;
            error) color=$'\033[0;31m' ;; success) color=$'\033[0;32m' ;;
        esac
        reset=$'\033[0m'
    fi
    printf '%(%Y-%m-%d %H:%M:%S)T [%s%s%s] %s\n' -1 "$color" "$level" "$reset" "$msg" >&2
}

info()    { _clyops_log info "$*"; }
warn()    { _clyops_log warning "$*"; }
error()   { _clyops_log error "$*"; }
success() { _clyops_log success "$*"; }
# Usage: die <exit_code> <message>
die()     { local code="$1"; shift; _clyops_log error "$*" force; exit "$code"; }

_clyops_fatal() { _clyops_log error "$1" force; exit 2; }

# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

clyops_name()        { _CLYOPS_NAME="$1"; }
clyops_root()        { _CLYOPS_ROOT="$1"; }
clyops_description() { _clyops_record clyops_description "$@" || _CLYOPS_DESCRIPTION="$1"; }
clyops_epilog()      { _clyops_record clyops_epilog "$@" || _CLYOPS_EPILOG="$1"; }

# Inside a command, record a registration instead of making it (returns 0).
_clyops_record() {
    [[ -n "$_CLYOPS_CUR" && -z "$_CLYOPS_REPLAYING" ]] || return 1
    printf -v _r ' %q' "$@"
    _CLYOPS_CMD_REC[:$_CLYOPS_CUR]+="$_r"$'\n'
}

# Usage: clyops_command "<word> [<word>...]" <description>
# Registers a command (spec section 1.7); later registrations belong to it.
# "db migrate" is the migrate command of db, which must be registered first.
clyops_command() {
    local path="$1" parent="" word="${1##* }"
    [[ "$path" == *" "* ]] && parent="${path% *}"
    [[ -z "$parent" || -v "_CLYOPS_CMD_ABOUT[:$parent]" ]] || _clyops_fatal "clyops_command: unknown command $parent"
    [[ -v "_CLYOPS_CMD_ABOUT[:$path]" ]] && _clyops_fatal "Duplicate command $path"
    if [[ -n "${_CLYOPS_CMD_HASARGS[:$parent]:-}" ]] || [[ -z "$parent" && ${#_CLYOPS_ARGS[@]} -gt 0 ]]; then
        _clyops_fatal "Cannot mix commands and positional arguments"
    fi
    _CLYOPS_CMD_ABOUT[:$path]="$2"
    _CLYOPS_CMD_KIDS[:$parent]+="${_CLYOPS_CMD_KIDS[:$parent]:+ }$word"
    _CLYOPS_CUR="$path"
}

# Usage: clyops_effects <effect>...   (read-only, idempotent, destructive, network)
clyops_effects() {
    _clyops_record clyops_effects "$@" && return 0
    local e
    for e in "$@"; do
        case "$e" in read-only|idempotent|destructive|network) ;; *) _clyops_fatal "Unknown effect '$e'" ;; esac
    done
    _CLYOPS_EFFECTS=("$@")
}

# Usage: clyops_stdin <description> [content-type]   /   clyops_stdout <description> [content-type]
clyops_stdin()  { _clyops_record clyops_stdin "$@" || _CLYOPS_STDIN=("$1" "${2:-}"); }
clyops_stdout() { _clyops_record clyops_stdout "$@" || _CLYOPS_STDOUT=("$1" "${2:-}"); }

# Usage: clyops_exclusive <long>...  /  clyops_requires <long> <long>...  /  clyops_one_of <long>...
clyops_exclusive() { _clyops_record clyops_exclusive "$@" || _clyops_constraint exclusive "$@"; }
clyops_requires()  { _clyops_record clyops_requires "$@" || _clyops_constraint requires "$@"; }
clyops_one_of()    { _clyops_record clyops_one_of "$@" || _clyops_constraint oneOf "$@"; }

_clyops_constraint() {
    local type="$1" long; shift
    for long in "$@"; do
        [[ -v "_CLYOPS_KIND[$long]" ]] || _clyops_fatal "Unknown option --$long in constraint"
    done
    _CLYOPS_CON_TYPE+=("$type"); _CLYOPS_CON_OPTS+=("$*"); _CLYOPS_CON_OWNER+=("$_CLYOPS_SEL")
}

# Select command $1 (its parent already selected): replay its registrations.
# Its options go first, so the chain's options read deepest command first.
_clyops_enter() {
    local path="$1" n0=${#_CLYOPS_OPTS[@]}
    _CLYOPS_SEL="$path"
    [[ -n "${_CLYOPS_ENTERED[:$path]:-}" ]] && return 0
    _CLYOPS_ENTERED[:$path]=1
    _CLYOPS_DESCRIPTION="${_CLYOPS_CMD_ABOUT[:$path]}" _CLYOPS_EPILOG="" _CLYOPS_EFFECTS=() _CLYOPS_STDIN=() _CLYOPS_STDOUT=()
    _CLYOPS_REPLAYING=1
    eval "${_CLYOPS_CMD_REC[:$path]:-}"
    _CLYOPS_REPLAYING=""
    _CLYOPS_OPTS=("${_CLYOPS_OPTS[@]:n0}" "${_CLYOPS_OPTS[@]:0:n0}")
}

# Select the command words $@ from the program down; stops at the first that is not a command.
# Sets _r to the number of words followed.
_clyops_walk() {
    local n=0 w
    for w in "$@"; do
        [[ " ${_CLYOPS_CMD_KIDS[:$_CLYOPS_SEL]:-} " == *" $w "* ]] || break
        _clyops_enter "${_CLYOPS_SEL:+$_CLYOPS_SEL }$w"
        n=$((n + 1))
    done
    _r=$n
}

# Usage: clyops_config <option-long-name> <prefix[,prefix...]>
clyops_config() {
    _clyops_record clyops_config "$@" && return 0
    _CLYOPS_CONFIG_OPT="$1"
    local IFS=',' p
    _CLYOPS_CONFIG_PREFIXES=()
    for p in $2; do
        p="${p#"${p%%[![:space:]]*}"}"; p="${p%"${p##*[![:space:]]}"}"
        [[ -n "$p" ]] && _CLYOPS_CONFIG_PREFIXES+=("$p")
    done
}

# Usage: clyops_require_command <command> <description> [install-hint]
clyops_require_command() {
    _clyops_record clyops_require_command "$@" && return 0
    _CLYOPS_CMDS+=("$1"); _CLYOPS_CMD_DESC+=("$2"); _CLYOPS_CMD_HINT+=("${3:-}"); _CLYOPS_CMD_OWNER+=("$_CLYOPS_SEL")
}

# Usage: clyops_path_search <long> <dir[:dir...]>   (dirs relative to the root)
clyops_path_search() {
    _clyops_record clyops_path_search "$@" && return 0
    [[ -v "_CLYOPS_KIND[$1]" ]] || _clyops_fatal "clyops_path_search: unknown option --$1"
    _CLYOPS_SEARCH[$1]="$2"
    [[ -n "${_CLYOPS_RULE[$1]}" ]] || _CLYOPS_RULE[$1]="path"
}

_clyops_known_rule() {
    case "$1" in
        ""|int|float|string|path|ip|hostname|url|port|email|uuid|bool|date:YYYY-MM-DD) return 0 ;;
        file:exists|file:readable|file:writable|dir:exists|dir:writable) return 0 ;;
        choice:?*|regex:?*) return 0 ;;
    esac
    [[ "$1" =~ ^int:([0-9]+-[0-9]*|-[0-9]+)$ ]] && return 0
    [[ "$1" =~ ^float:([0-9]*\.?[0-9]+-([0-9]*\.?[0-9]+)?|-[0-9]*\.?[0-9]+)$ ]] && return 0
    [[ "$1" =~ ^string:([0-9]+|[0-9]+-[0-9]*|-[0-9]+)$ ]] && return 0
    return 1
}

_clyops_add_opt() { # var long short kind default required desc group rule
    local _c_var="$1" _c_long="$2" _c_short="$3"
    [[ -v "_CLYOPS_KIND[$_c_long]" ]] && _clyops_fatal "Duplicate option --$_c_long"
    if [[ -n "$_c_short" ]]; then
        [[ ${#_c_short} -ne 1 || -v "_CLYOPS_BYSHORT[$_c_short]" ]] && _clyops_fatal "Invalid or duplicate short option -$_c_short"
        _CLYOPS_BYSHORT[$_c_short]="$_c_long"
    fi
    local _c_rule="$9"
    if [[ "$_c_rule" == secret || "$_c_rule" == secret:* ]]; then _CLYOPS_SECRET[$_c_long]=1; _c_rule="${_c_rule:7}"; fi
    _clyops_known_rule "$_c_rule" || _clyops_fatal "Unknown validation rule '$_c_rule' for --$_c_long"
    _CLYOPS_OWNER[$_c_long]="$_CLYOPS_SEL"
    _CLYOPS_INDEX[$_c_long]=$(( ${#_CLYOPS_INDEX[@]} ))
    _CLYOPS_OPTS+=("$_c_long")
    _CLYOPS_VAR[$_c_long]="$_c_var"; _CLYOPS_SHORT[$_c_long]="$_c_short"; _CLYOPS_KIND[$_c_long]="$4"
    _CLYOPS_DEFAULT[$_c_long]="$5"; _CLYOPS_REQUIRED[$_c_long]="$6"; _CLYOPS_DESC[$_c_long]="$7"
    _CLYOPS_GROUP[$_c_long]="${8:-Options}"; _CLYOPS_RULE[$_c_long]="$_c_rule"; _CLYOPS_SEARCH[$_c_long]=""
    # The environment is read when the option is registered: once parsed, the
    # variable holds the option's value instead.
    if [[ "$4" != array && -n "${!_c_var:-}" ]]; then _CLYOPS_ENV[$_c_long]="${!_c_var}"; fi
}

# Usage: clyops_opt <VAR> <long> <short> <default|flag|optional|""> <description> [group] [rule]
clyops_opt() {
    _clyops_record clyops_opt "$@" && return 0
    local _c_kind=value _c_dflt="$4" _c_req=""
    case "$4" in
        flag) _c_kind=flag; _c_dflt="" ;;
        optional) _c_dflt="" ;;
        "") _c_req=1 ;;
    esac
    _clyops_add_opt "$1" "$2" "$3" "$_c_kind" "$_c_dflt" "$_c_req" "$5" "${6:-Options}" "${7:-}"
}

# Usage: clyops_opt_array <VAR> <long> <short> <description> [group] [rule]
clyops_opt_array() {
    _clyops_record clyops_opt_array "$@" && return 0
    _clyops_add_opt "$1" "$2" "$3" array "" "" "$4" "${5:-Options}" "${6:-}"
}

# Usage: clyops_arg <NAME> <description> [default] [rule]
clyops_arg() {
    [[ -n "${_CLYOPS_CMD_KIDS[:$_CLYOPS_CUR]:-}" ]] && _clyops_fatal "Cannot mix commands and positional arguments"
    if [[ -n "$_CLYOPS_CUR" && -z "$_CLYOPS_REPLAYING" ]]; then
        _CLYOPS_CMD_HASARGS[:$_CLYOPS_CUR]=1
        _clyops_record clyops_arg "$@"
        return 0
    fi
    [[ -n "$_CLYOPS_VARIADIC" ]] && _clyops_fatal "Argument $1 registered after a variadic argument"
    _clyops_known_rule "${4:-}" || _clyops_fatal "Unknown validation rule '${4:-}' for $1"
    _CLYOPS_ARGS+=("$1"); _CLYOPS_ARG_DESC+=("$2"); _CLYOPS_ARG_DEFAULT+=("${3:-}"); _CLYOPS_ARG_RULE+=("${4:-}")
}

# Usage: clyops_arg_variadic <NAME> <description> [rule]
clyops_arg_variadic() {
    if [[ -n "$_CLYOPS_CUR" && -z "$_CLYOPS_REPLAYING" ]]; then
        _CLYOPS_CMD_HASARGS[:$_CLYOPS_CUR]=1
        _clyops_record clyops_arg_variadic "$@"
        return 0
    fi
    clyops_arg "$1" "$2" "" "${3:-}"
    _CLYOPS_VARIADIC=$(( ${#_CLYOPS_ARGS[@]} - 1 ))
}

_clyops_ensure_help() {
    [[ -v "_CLYOPS_KIND[help]" ]] && return 0
    local _c_short=h _CLYOPS_SEL=""
    [[ -v "_CLYOPS_BYSHORT[h]" ]] && _c_short=""
    _clyops_add_opt HELP help "$_c_short" flag "" "" "Show this help message and exit" Global ""
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_clyops_bool_word() { # sets _r to true/false; returns 1 if not a boolean word
    case "${1,,}" in
        true|yes|1|on) _r=true ;;
        false|no|0|off) _r=false ;;
        *) return 1 ;;
    esac
}

_clyops_is_path_rule() { [[ "$1" == path || "$1" == file:* || "$1" == dir:* ]]; }

_clyops_is_bool_like() {
    [[ "${_CLYOPS_KIND[$1]}" == flag ]] && return 0
    case "${_CLYOPS_RULE[$1]}" in bool|choice:true,false|choice:false,true) return 0 ;; esac
    return 1
}

# Lexically normalize an absolute path into _r.
_clyops_normpath() {
    local IFS=/ part
    local -a parts out=()
    read -ra parts <<< "$1"
    for part in "${parts[@]}"; do
        case "$part" in
            ""|.) ;;
            ..) (( ${#out[@]} )) && unset 'out[${#out[@]}-1]' ;;
            *) out+=("$part") ;;
        esac
    done
    printf -v _r '/%s' "${out[@]}"
}

# Absolute, normalized form of $1 relative to $2, into _r.
_clyops_abspath() {
    if [[ "$1" == /* ]]; then _clyops_normpath "$1"; else _clyops_normpath "$2/$1"; fi
}

# Resolve a path value (spec section 6) into _r.
# Usage: _clyops_resolve <value> <base> [search-dirs (absolute, colon-separated)]
_clyops_resolve() {
    local value="$1" base="$2" dirs="${3:-}" dir
    case "$value" in
        ""|-|disabled|optional|/*) _r="$value"; return ;;
    esac
    if [[ "$value" =~ ^[A-Za-z][A-Za-z0-9+.-]+: ]]; then _r="$value"; return; fi
    _clyops_abspath "$value" "$base"
    local from_base="$_r"
    if [[ -n "$dirs" && ! -e "$from_base" ]]; then
        case "$value" in
            .|..|./*|../*) ;;
            *)
                local IFS=:
                for dir in $dirs; do
                    [[ -n "$dir" && -e "$dir/$value" ]] || continue
                    _clyops_abspath "$value" "$dir"
                    return
                done
                ;;
        esac
    fi
    _r="$from_base"
}

_clyops_search_dirs() { # absolute search dirs of option $1 into _r
    local IFS=: dir out=()
    for dir in ${_CLYOPS_SEARCH[$1]}; do
        [[ -z "$dir" ]] && continue
        _clyops_abspath "$dir" "$_CLYOPS_ROOT_ABS"
        out+=("$_r")
    done
    _r="${out[*]}"
}

_clyops_bounds() { # "int:MIN-MAX" -> _lo _hi
    local range="${1#*:}"
    _lo="${range%%-*}"; _hi="${range#*-}"
}

_clyops_int_lt() { # a < b for decimal integers of any sign/leading zeros
    local a="$1" b="$2" sa=1 sb=1
    [[ "$a" == -* ]] && { sa=-1; a="${a#-}"; }
    [[ "$b" == -* ]] && { sb=-1; b="${b#-}"; }
    (( sa * 10#$a < sb * 10#$b ))
}

_clyops_float_lt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 < b + 0) }'; }

# Validate value $1 against rule $2 for NAME $3. Sets _CLYOPS_ERROR and
# returns 1 on failure. A bool rule normalizes the value into _r.
_clyops_validate() {
    local v="$1" rule="$2" name="$3" _lo _hi
    _r="$v"
    case "$rule" in
        int|int:*)
            [[ "$v" =~ ^-?[0-9]+$ ]] || { _CLYOPS_ERROR="$name must be an integer, got '$v'"; return 1; }
            if [[ "$rule" == int:* ]]; then
                _clyops_bounds "$rule"
                if [[ -n "$_lo" ]] && _clyops_int_lt "$v" "$_lo"; then _CLYOPS_ERROR="$name must be >= $_lo, got $v"; return 1; fi
                if [[ -n "$_hi" ]] && _clyops_int_lt "$_hi" "$v"; then _CLYOPS_ERROR="$name must be <= $_hi, got $v"; return 1; fi
            fi ;;
        float|float:*)
            [[ "$v" =~ ^-?[0-9]*\.?[0-9]+$ ]] || { _CLYOPS_ERROR="$name must be a number, got '$v'"; return 1; }
            if [[ "$rule" == float:* ]]; then
                _clyops_bounds "$rule"
                if [[ -n "$_lo" ]] && _clyops_float_lt "$v" "$_lo"; then _CLYOPS_ERROR="$name must be >= $_lo, got $v"; return 1; fi
                if [[ -n "$_hi" ]] && _clyops_float_lt "$_hi" "$v"; then _CLYOPS_ERROR="$name must be <= $_hi, got $v"; return 1; fi
            fi ;;
        string:*)
            local len=${#v}
            if [[ "$rule" != *-* ]]; then
                (( len == ${rule#string:} )) || { _CLYOPS_ERROR="$name must be exactly ${rule#string:} characters, got $len"; return 1; }
            else
                _clyops_bounds "$rule"
                if [[ -n "$_lo" ]] && (( len < _lo )); then _CLYOPS_ERROR="$name must be at least $_lo characters, got $len"; return 1; fi
                if [[ -n "$_hi" ]] && (( len > _hi )); then _CLYOPS_ERROR="$name must be at most $_hi characters, got $len"; return 1; fi
            fi ;;
        choice:*)
            local choices="${rule#choice:}" c IFS=,
            for c in $choices; do [[ "$v" == "$c" ]] && return 0; done
            _CLYOPS_ERROR="$name must be one of: ${choices//,/, }, got '$v'"; return 1 ;;
        regex:*)
            local pattern="${rule#regex:}"
            [[ "$v" =~ $pattern ]] || { _CLYOPS_ERROR="$name does not match required pattern, got '$v'"; return 1; } ;;
        bool)
            _clyops_bool_word "$v" || { _CLYOPS_ERROR="$name must be a boolean (true/false, yes/no, 1/0, on/off), got '$v'"; return 1; } ;;
        port)
            if ! [[ "$v" =~ ^[0-9]+$ ]] || (( 10#$v < 1 || 10#$v > 65535 )); then
                _CLYOPS_ERROR="$name must be a valid port (1-65535), got '$v'"; return 1
            fi ;;
        ip)
            if ! [[ "$v" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$v" =~ ^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$ ]]; then
                _CLYOPS_ERROR="$name must be a valid IP address, got '$v'"; return 1
            fi ;;
        hostname)
            [[ "$v" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$ ]] \
                || { _CLYOPS_ERROR="$name must be a valid hostname, got '$v'"; return 1; } ;;
        url)
            [[ "$v" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$ ]] || { _CLYOPS_ERROR="$name must be a valid URL, got '$v'"; return 1; } ;;
        email)
            [[ "$v" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || { _CLYOPS_ERROR="$name must be a valid email address, got '$v'"; return 1; } ;;
        uuid)
            [[ "$v" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
                || { _CLYOPS_ERROR="$name must be a valid UUID, got '$v'"; return 1; } ;;
        date:YYYY-MM-DD)
            [[ "$v" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { _CLYOPS_ERROR="$name must be in YYYY-MM-DD format, got '$v'"; return 1; } ;;
        file:exists)
            [[ -f "$v" ]] || { _CLYOPS_ERROR="$name file does not exist: $v"; return 1; } ;;
        file:readable)
            [[ -r "$v" ]] || { _CLYOPS_ERROR="$name file is not readable: $v"; return 1; } ;;
        file:writable)
            if [[ -e "$v" ]]; then
                [[ -w "$v" ]] || { _CLYOPS_ERROR="$name file is not writable: $v"; return 1; }
            else
                local dir="${v%/*}"; dir="${dir:-/}"
                [[ -d "$dir" && -w "$dir" ]] || { _CLYOPS_ERROR="$name directory is not writable: $dir"; return 1; }
            fi ;;
        dir:exists)
            [[ -d "$v" ]] || { _CLYOPS_ERROR="$name directory does not exist: $v"; return 1; } ;;
        dir:writable)
            [[ -d "$v" && -w "$v" ]] || { _CLYOPS_ERROR="$name directory does not exist or is not writable: $v"; return 1; } ;;
    esac
    _r="$v"
    [[ "$rule" == bool ]] && _clyops_bool_word "$v"
    return 0
}

_clyops_describe_rule() { # help text for rule $1 into _r
    local rule="$1" _lo _hi noun suffix=""
    case "$rule" in
        int) _r="integer" ;; float) _r="number" ;; string) _r="text" ;; path) _r="path" ;;
        ip) _r="IP address" ;; hostname) _r="hostname" ;; url) _r="URL" ;; port) _r="port: 1-65535" ;;
        email) _r="email address" ;; uuid) _r="UUID" ;; bool) _r="true/false, yes/no, 1/0, on/off" ;;
        date:YYYY-MM-DD) _r="date: YYYY-MM-DD" ;;
        file:exists) _r="existing file" ;; file:readable) _r="readable file" ;; file:writable) _r="writable file" ;;
        dir:exists) _r="existing directory" ;; dir:writable) _r="writable directory" ;;
        choice:*) _r="${rule#choice:}"; _r="choices: ${_r//,/, }" ;;
        regex:*) _r="pattern: ${rule#regex:}" ;;
        int:*|float:*|string:*)
            case "$rule" in int:*) noun=integer ;; float:*) noun=number ;; *) noun=text; suffix=" chars" ;; esac
            if [[ "$rule" != *-* ]]; then _r="$noun: ${rule#*:}$suffix"; return; fi
            _clyops_bounds "$rule"
            if [[ -n "$_lo" && -n "$_hi" ]]; then _r="$noun: $_lo-$_hi$suffix"
            elif [[ -n "$_lo" ]]; then _r="$noun: >=$_lo$suffix"
            else _r="$noun: <=$_hi$suffix"; fi ;;
        *) _r="$rule" ;;
    esac
}

# Append a value to option $1's list.
_clyops_list_push() { local -n _c_list="_CLYOPS_LIST_${_CLYOPS_INDEX[$1]}"; _c_list+=("$2"); }
_clyops_list_reset() { declare -ga "_CLYOPS_LIST_${_CLYOPS_INDEX[$1]}=()"; }

# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

_clyops_set_cli() { # long value
    if [[ "${_CLYOPS_KIND[$1]}" == array ]]; then
        [[ "${_CLYOPS_SRC[$1]:-}" == cli ]] || _clyops_list_reset "$1"
        _clyops_list_push "$1" "$2"
    else
        _CLYOPS_RAW[$1]="$2"
    fi
    _CLYOPS_HAS[$1]=1
    _CLYOPS_SRC[$1]=cli
}

_clyops_scan() {
    local pos=0 end_of_options="" token name value opt cluster j c
    local nargs=${#_CLYOPS_ARGS[@]}
    while (( $# > 0 )); do
        token="$1"; shift
        if [[ -n "$end_of_options" || "$token" == - || "$token" != -* ]]; then
            if [[ -n "${_CLYOPS_CMD_KIDS[:$_CLYOPS_SEL]:-}" ]]; then
                _clyops_walk "$token"
                (( _r )) || { _CLYOPS_ERROR="Unknown command: $token"; return 1; }
                nargs=${#_CLYOPS_ARGS[@]}
            elif [[ -n "$_CLYOPS_VARIADIC" ]] && (( pos > _CLYOPS_VARIADIC )); then
                _CLYOPS_REST+=("$token")
            elif (( pos >= nargs )); then
                _CLYOPS_ERROR="Unexpected argument: $token"; return 1
            elif [[ "$pos" == "$_CLYOPS_VARIADIC" ]]; then
                _CLYOPS_REST+=("$token"); pos=$((pos + 1))
            else
                _CLYOPS_ARGV[pos]="$token"; pos=$((pos + 1))
            fi
        elif [[ "$token" == -- ]]; then
            end_of_options=1
        elif [[ "$token" == --* ]]; then
            name="${token#--}"
            if [[ "$name" == *=* ]]; then
                value="${name#*=}"; name="${name%%=*}"
                [[ -v "_CLYOPS_KIND[$name]" ]] || { _CLYOPS_ERROR="Unknown option: --$name"; return 1; }
                if [[ "${_CLYOPS_KIND[$name]}" == flag ]]; then
                    _clyops_bool_word "$value" || { _CLYOPS_ERROR="Option --$name expects a boolean value, got '$value'"; return 1; }
                    value="$_r"
                fi
                _clyops_set_cli "$name" "$value"
            elif [[ -v "_CLYOPS_KIND[$name]" ]]; then
                if [[ "${_CLYOPS_KIND[$name]}" == flag ]]; then
                    _clyops_set_cli "$name" true
                else
                    (( $# > 0 )) && [[ "$1" != --* ]] || { _CLYOPS_ERROR="Option --$name requires an argument"; return 1; }
                    _clyops_set_cli "$name" "$1"; shift
                fi
            elif [[ "$name" == no-* && -v "_CLYOPS_KIND[${name#no-}]" ]]; then
                _clyops_is_bool_like "${name#no-}" || { _CLYOPS_ERROR="Option --$name can only be used with flag/boolean options"; return 1; }
                _clyops_set_cli "${name#no-}" false
            else
                _CLYOPS_ERROR="Unknown option: --$name"; return 1
            fi
        else
            cluster="${token#-}"
            for (( j = 0; j < ${#cluster}; j++ )); do
                c="${cluster:j:1}"
                [[ -v "_CLYOPS_BYSHORT[$c]" ]] || { _CLYOPS_ERROR="Unknown option: -$c"; return 1; }
                opt="${_CLYOPS_BYSHORT[$c]}"
                if [[ "${_CLYOPS_KIND[$opt]}" == flag ]]; then _clyops_set_cli "$opt" true; continue; fi
                if (( j + 1 < ${#cluster} )); then _clyops_set_cli "$opt" "${cluster:j+1}"; break; fi
                (( $# > 0 )) && [[ "$1" != -* ]] || { _CLYOPS_ERROR="Option -$c requires an argument"; return 1; }
                _clyops_set_cli "$opt" "$1"; shift
            done
        fi
    done
    return 0
}

_clyops_read_config() { # file depth
    local file="$1" depth="$2" dir line trimmed body prefix key value target
    if (( depth > 10 )); then _CLYOPS_ERROR="Config include depth exceeded (10) while processing: $file"; return 1; fi
    [[ -f "$file" ]] || { _CLYOPS_ERROR="Config file not found: $file"; return 1; }
    [[ -v "_CLYOPS_CFG_STACK[$file]" ]] && { _CLYOPS_ERROR="Circular config include detected: $file"; return 1; }
    _CLYOPS_CFG_STACK[$file]=1
    dir="${file%/*}"; dir="${dir:-/}"
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        trimmed="${line#"${line%%[![:space:]]*}"}"
        [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
        if [[ "$line" =~ ^[[:space:]]*@include[[:space:]]+(.+)$ ]]; then
            target="${BASH_REMATCH[1]}"
            target="${target%"${target##*[![:space:]]}"}"
            if [[ "$target" =~ ^\"(.*)\"$ || "$target" =~ ^\'(.*)\'$ ]]; then target="${BASH_REMATCH[1]}"; fi
            _clyops_abspath "$target" "$dir"
            _clyops_read_config "$_r" $((depth + 1)) || return 1
            continue
        fi
        if (( ${#_CLYOPS_CONFIG_PREFIXES[@]} == 0 )); then
            body="$line"
        else
            body=""
            local matched=""
            for prefix in "${_CLYOPS_CONFIG_PREFIXES[@]}"; do
                if [[ "$line" == "$prefix"* ]]; then body="${line#"$prefix"}"; matched=1; break; fi
            done
            [[ -n "$matched" ]] || continue
        fi
        [[ "$body" == *=* ]] || continue
        key="${body%%=*}"; value="${body#*=}"
        key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"; key="${key#--}"
        value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"
        [[ -z "$key" ]] && continue
        _CLYOPS_CFG_VAL[$key]="$value"
        _CLYOPS_CFG_DIR[$key]="$dir"
        _CLYOPS_CFG_ORDER+=("$key")
    done < "$file"
    unset "_CLYOPS_CFG_STACK[$file]"
    return 0
}

_clyops_load_config() {
    local opt="$_CLYOPS_CONFIG_OPT" file="" src=cli key
    [[ -v "_CLYOPS_KIND[$opt]" ]] || return 0
    if [[ "${_CLYOPS_HAS[$opt]:-}" ]]; then file="${_CLYOPS_RAW[$opt]}"
    elif [[ -v "_CLYOPS_ENV[$opt]" ]]; then file="${_CLYOPS_ENV[$opt]}"; src="env"
    elif [[ -n "${_CLYOPS_DEFAULT[$opt]}" ]]; then file="${_CLYOPS_DEFAULT[$opt]}"; src=default
    fi
    [[ -z "$file" || "$file" == disabled ]] && return 0

    _clyops_search_dirs "$opt"
    _clyops_resolve "$file" "$PWD" "$_r"
    file="$_r"
    _CLYOPS_RAW[$opt]="$file"; _CLYOPS_HAS[$opt]=1; _CLYOPS_SRC[$opt]="$src"

    declare -gA _CLYOPS_CFG_STACK=()
    _CLYOPS_CFG_ORDER=()
    _clyops_read_config "$file" 0 || return 1

    for key in "${!_CLYOPS_CFG_VAL[@]}"; do
        [[ -v "_CLYOPS_KIND[$key]" && "$key" != "$opt" && "${_CLYOPS_SRC[$key]:-}" != cli ]] || continue
        local value="${_CLYOPS_CFG_VAL[$key]}"
        case "${_CLYOPS_KIND[$key]}" in
            flag)
                _clyops_bool_word "$value" || { _CLYOPS_ERROR="Config value for --$key must be a boolean, got '$value'"; return 1; }
                _CLYOPS_RAW[$key]="$_r" ;;
            array) _clyops_list_reset "$key"; _clyops_list_push "$key" "$value" ;;
            *) _CLYOPS_RAW[$key]="$value" ;;
        esac
        _CLYOPS_HAS[$key]=1; _CLYOPS_SRC[$key]=config
    done
    return 0
}

# Steps 6-9 of the pipeline (defaults, env, paths, validation).
_clyops_resolve_values() {
    local i n=${#_CLYOPS_ARGS[@]} long rule base value name
    [[ -n "${_CLYOPS_CMD_KIDS[:$_CLYOPS_SEL]:-}" ]] && { _CLYOPS_ERROR="Missing command"; return 1; }
    for (( i = 0; i < n; i++ )); do
        [[ "$i" == "$_CLYOPS_VARIADIC" || -v "_CLYOPS_ARGV[i]" ]] && continue
        if [[ -z "${_CLYOPS_ARG_DEFAULT[i]}" ]]; then
            _CLYOPS_ERROR="Missing required positional argument: ${_CLYOPS_ARGS[i]}"; return 1
        fi
        _CLYOPS_ARGV[i]="${_CLYOPS_ARG_DEFAULT[i]}"
    done

    for long in "${_CLYOPS_OPTS[@]}"; do
        [[ -v "_CLYOPS_SRC[$long]" ]] && continue
        if [[ -v "_CLYOPS_ENV[$long]" ]]; then
            value="${_CLYOPS_ENV[$long]}"
            if [[ "${_CLYOPS_KIND[$long]}" == flag ]]; then
                _clyops_bool_word "$value" || { _CLYOPS_ERROR="Environment variable ${_CLYOPS_VAR[$long]} must be a boolean, got '$value'"; return 1; }
                value="$_r"
            fi
            _CLYOPS_RAW[$long]="$value"; _CLYOPS_HAS[$long]=1; _CLYOPS_SRC[$long]="env"
        elif [[ "${_CLYOPS_KIND[$long]}" == flag ]]; then
            _CLYOPS_RAW[$long]=false; _CLYOPS_HAS[$long]=1; _CLYOPS_SRC[$long]=default
        elif [[ -n "${_CLYOPS_DEFAULT[$long]}" ]]; then
            _CLYOPS_RAW[$long]="${_CLYOPS_DEFAULT[$long]}"; _CLYOPS_HAS[$long]=1; _CLYOPS_SRC[$long]=default
        fi
    done

    # Path resolution; the base depends on where each value came from.
    for long in "${_CLYOPS_OPTS[@]}"; do
        rule="${_CLYOPS_RULE[$long]}"
        _clyops_is_path_rule "$rule" && [[ "${_CLYOPS_HAS[$long]:-}" && "$long" != "$_CLYOPS_CONFIG_OPT" ]] || continue
        case "${_CLYOPS_SRC[$long]}" in
            cli) base="$PWD" ;;
            config) base="${_CLYOPS_CFG_DIR[$long]}" ;;
            *) base="$_CLYOPS_ROOT_ABS" ;;
        esac
        _clyops_search_dirs "$long"
        local dirs="$_r"
        if [[ "${_CLYOPS_KIND[$long]}" == array ]]; then
            local -n _c_list="_CLYOPS_LIST_${_CLYOPS_INDEX[$long]}"
            for i in "${!_c_list[@]}"; do _clyops_resolve "${_c_list[i]}" "$base" "$dirs"; _c_list[i]="$_r"; done
            unset -n _c_list
        else
            _clyops_resolve "${_CLYOPS_RAW[$long]}" "$base" "$dirs"; _CLYOPS_RAW[$long]="$_r"
        fi
    done
    for (( i = 0; i < n; i++ )); do
        _clyops_is_path_rule "${_CLYOPS_ARG_RULE[i]}" || continue
        if [[ "$i" == "$_CLYOPS_VARIADIC" ]]; then
            local k
            for k in "${!_CLYOPS_REST[@]}"; do _clyops_resolve "${_CLYOPS_REST[k]}" "$PWD"; _CLYOPS_REST[k]="$_r"; done
        else
            _clyops_resolve "${_CLYOPS_ARGV[i]}" "$PWD"; _CLYOPS_ARGV[i]="$_r"
        fi
    done

    # Validation; empty values are not validated.
    for long in "${_CLYOPS_OPTS[@]}"; do
        rule="${_CLYOPS_RULE[$long]}"
        [[ -n "$rule" && "${_CLYOPS_HAS[$long]:-}" ]] || continue
        if [[ "${_CLYOPS_KIND[$long]}" == array ]]; then
            local -n _c_list="_CLYOPS_LIST_${_CLYOPS_INDEX[$long]}"
            for i in "${!_c_list[@]}"; do
                [[ -z "${_c_list[i]}" ]] && continue
                _clyops_validate "${_c_list[i]}" "$rule" "--$long" || return 1
                _c_list[i]="$_r"
            done
            unset -n _c_list
        elif [[ -n "${_CLYOPS_RAW[$long]}" ]]; then
            _clyops_validate "${_CLYOPS_RAW[$long]}" "$rule" "--$long" || return 1
            _CLYOPS_RAW[$long]="$_r"
        fi
    done
    for (( i = 0; i < n; i++ )); do
        rule="${_CLYOPS_ARG_RULE[i]}"; name="${_CLYOPS_ARGS[i]}"
        [[ -n "$rule" ]] || continue
        if [[ "$i" == "$_CLYOPS_VARIADIC" ]]; then
            local k
            for k in "${!_CLYOPS_REST[@]}"; do
                [[ -z "${_CLYOPS_REST[k]}" ]] && continue
                _clyops_validate "${_CLYOPS_REST[k]}" "$rule" "$name" || return 1
                _CLYOPS_REST[k]="$_r"
            done
        elif [[ -n "${_CLYOPS_ARGV[i]}" ]]; then
            _clyops_validate "${_CLYOPS_ARGV[i]}" "$rule" "$name" || return 1
            _CLYOPS_ARGV[i]="$_r"
        fi
    done
    return 0
}

# Copy resolved values into the caller's variables.
_clyops_assign() {
    local _c_long _c_i
    for _c_long in "${_CLYOPS_OPTS[@]}"; do
        if [[ "${_CLYOPS_KIND[$_c_long]}" == array ]]; then
            local -n _c_list="_CLYOPS_LIST_${_CLYOPS_INDEX[$_c_long]}"
            if [[ "${_CLYOPS_HAS[$_c_long]:-}" ]]; then
                declare -ga "${_CLYOPS_VAR[$_c_long]}=(\"\${_c_list[@]}\")"
            else
                declare -ga "${_CLYOPS_VAR[$_c_long]}=()"
            fi
            unset -n _c_list
        else
            printf -v "${_CLYOPS_VAR[$_c_long]}" '%s' "${_CLYOPS_RAW[$_c_long]:-}"
        fi
    done
    # shellcheck disable=SC2034  # public: the selected command words
    read -ra CLYOPS_COMMAND <<< "$_CLYOPS_SEL"
    for (( _c_i = 0; _c_i < ${#_CLYOPS_ARGS[@]}; _c_i++ )); do
        if [[ "$_c_i" == "$_CLYOPS_VARIADIC" ]]; then
            declare -ga "${_CLYOPS_ARGS[_c_i]}=(\"\${_CLYOPS_REST[@]}\")"
        else
            printf -v "${_CLYOPS_ARGS[_c_i]}" '%s' "${_CLYOPS_ARGV[_c_i]:-}"
        fi
    done
}

# Parse without exiting. Returns 0 when values were assigned; otherwise
# _CLYOPS_HELP is set (help requested) or _CLYOPS_ERROR holds the message.
clyops_parse() {
    local _c_long
    _clyops_ensure_help
    _CLYOPS_RAW=() _CLYOPS_HAS=() _CLYOPS_SRC=() _CLYOPS_CFG_VAL=() _CLYOPS_CFG_DIR=()
    _CLYOPS_ARGV=() _CLYOPS_REST=() _CLYOPS_ERROR="" _CLYOPS_DETAIL=() _CLYOPS_SHOW_USAGE=1 _CLYOPS_HELP=""
    _CLYOPS_SEL=""
    for _c_long in "${_CLYOPS_OPTS[@]}"; do
        [[ "${_CLYOPS_KIND[$_c_long]}" == array ]] && _clyops_list_reset "$_c_long"
    done
    _clyops_abspath "${_CLYOPS_ROOT:-.}" "$PWD"
    _CLYOPS_ROOT_ABS="$_r"

    local _c_ok=0
    _clyops_scan "$@" || _c_ok=1
    if (( _c_ok == 0 )) && [[ -n "$_CLYOPS_CONFIG_OPT" ]]; then _clyops_load_config || _c_ok=1; fi
    if [[ "${_CLYOPS_RAW[help]:-}" == true && "${_CLYOPS_SRC[help]:-}" == cli ]]; then _CLYOPS_HELP=1; return 1; fi
    (( _c_ok == 0 )) || return 1
    _clyops_resolve_values || return 1

    local _c_i _c_missing=()
    for (( _c_i = 0; _c_i < ${#_CLYOPS_CMDS[@]}; _c_i++ )); do
        type -P "${_CLYOPS_CMDS[_c_i]}" >/dev/null && continue
        _c_missing+=("${_CLYOPS_CMDS[_c_i]}")
        _CLYOPS_DETAIL+=("  ${_CLYOPS_CMDS[_c_i]} - ${_CLYOPS_CMD_DESC[_c_i]}")
        [[ -n "${_CLYOPS_CMD_HINT[_c_i]}" ]] && _CLYOPS_DETAIL+=("    Install: ${_CLYOPS_CMD_HINT[_c_i]}")
    done
    if (( ${#_c_missing[@]} )); then
        local IFS=,
        _CLYOPS_ERROR="Missing required command(s): ${_c_missing[*]}"
        _CLYOPS_ERROR="${_CLYOPS_ERROR//,/, }"
        _CLYOPS_SHOW_USAGE=""
        return 1
    fi

    _c_missing=()
    for _c_long in "${_CLYOPS_OPTS[@]}"; do
        [[ "${_CLYOPS_REQUIRED[$_c_long]}" && -z "${_CLYOPS_RAW[$_c_long]:-}" ]] && _c_missing+=("--$_c_long")
    done
    if (( ${#_c_missing[@]} )); then _CLYOPS_ERROR="Missing required argument(s): ${_c_missing[*]}"; return 1; fi
    _clyops_check_constraints || return 1

    _clyops_assign
    return 0
}

# An option is given when set by cli, config or env, and not false or an empty list.
_clyops_given() {
    case "${_CLYOPS_SRC[$1]:-}" in cli|config|env) ;; *) return 1 ;; esac
    [[ "${_CLYOPS_KIND[$1]}" == flag ]] && { [[ "${_CLYOPS_RAW[$1]}" == true ]]; return; }
    if [[ "${_CLYOPS_KIND[$1]}" == array ]]; then
        local -n _c_list="_CLYOPS_LIST_${_CLYOPS_INDEX[$1]}"
        (( ${#_c_list[@]} ))
        return
    fi
    return 0
}

# Spec section 1.6: the first relationship that fails, from the program down.
_clyops_check_constraints() {
    local i long first on=() longs=()
    for (( i = 0; i < ${#_CLYOPS_CON_TYPE[@]}; i++ )); do
        read -ra longs <<< "${_CLYOPS_CON_OPTS[i]}"
        on=()
        for long in "${longs[@]}"; do _clyops_given "$long" && on+=("$long"); done
        case "${_CLYOPS_CON_TYPE[i]}" in
            exclusive)
                (( ${#on[@]} > 1 )) && { _CLYOPS_ERROR="Options --${on[0]} and --${on[1]} cannot be used together"; return 1; } ;;
            requires)
                first="${longs[0]}"
                _clyops_given "$first" || continue
                for long in "${longs[@]:1}"; do
                    _clyops_given "$long" || { _CLYOPS_ERROR="Option --$first requires --$long"; return 1; }
                done ;;
            oneOf)
                if (( ${#on[@]} == 0 )); then
                    first=""
                    for long in "${longs[@]}"; do first+="${first:+, }--$long"; done
                    _CLYOPS_ERROR="One of $first is required"
                    return 1
                fi ;;
        esac
    done
    return 0
}

# Parse like a CLI: handles --help, --help-json-schema and --bash-completion,
# prints errors and exits on failure, otherwise assigns the variables.
clyops_run() {
    local _c_arg
    for _c_arg in "$@"; do
        [[ "$_c_arg" == -- ]] && break
        if [[ "$_c_arg" == --help-json-schema ]]; then clyops_json_schema; exit 0; fi
        if [[ "$_c_arg" == --bash-completion ]]; then
            local _c_words=("$@")
            while (( ${#_c_words[@]} )) && [[ "${_c_words[0]}" != -- ]]; do _c_words=("${_c_words[@]:1}"); done
            clyops_completion_data "${_c_words[@]:1}"
            exit 0
        fi
    done
    local _c_args=("$@") _c_i
    for (( _c_i = 0; _c_i < ${#_c_args[@]}; _c_i++ )); do
        [[ "${_c_args[_c_i]}" == -- ]] && break
        [[ "${_c_args[_c_i]}" == --completion ]] || continue
        clyops_completion_script "${_c_args[_c_i + 1]:-}" || die 1 "Unknown shell '${_c_args[_c_i + 1]:-}' (expected bash, zsh or fish)"
        exit 0
    done
    clyops_parse "$@" && return 0
    if [[ -n "$_CLYOPS_HELP" ]]; then clyops_usage; exit 0; fi
    _clyops_log error "$_CLYOPS_ERROR" force
    (( ${#_CLYOPS_DETAIL[@]} )) && printf '%s\n' "${_CLYOPS_DETAIL[@]}" >&2
    [[ -n "$_CLYOPS_SHOW_USAGE" ]] && clyops_usage >&2
    exit 1
}

# ---------------------------------------------------------------------------
# Accessors
# ---------------------------------------------------------------------------

# Print where an option's value came from: cli, config, env, default or unset.
clyops_source() { local long="${1#--}"; echo "${_CLYOPS_SRC[$long]:-unset}"; }
clyops_is_set() { [[ "${_CLYOPS_SRC[${1#--}]:-}" == cli ]]; }
clyops_is_explicitly_set() { case "${_CLYOPS_SRC[${1#--}]:-}" in cli|config|env) return 0 ;; esac; return 1; }

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

_clyops_json_str() { # JSON string literal for $1 into _r
    local s="$1"
    s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"; s="${s//$'\t'/\\t}"; s="${s//$'\r'/\\r}"
    _r="\"$s\""
}

_clyops_json_typed() { # typed JSON for value $1 of kind $2 / rule $3 into _r
    local v="$1" kind="$2" rule="$3"
    if [[ "$kind" == flag || "$rule" == bool ]]; then _r="$v"; return; fi
    if [[ "$rule" == int || "$rule" == int:* || "$rule" == port ]] && [[ "$v" =~ ^(-?)([0-9]+)$ ]]; then
        _r="${BASH_REMATCH[1]}$((10#${BASH_REMATCH[2]}))"; [[ "$_r" == -0 ]] && _r=0; return
    fi
    if [[ "$rule" == float || "$rule" == float:* ]] && [[ "$v" =~ ^(-?)([0-9]*)\.?([0-9]*)$ ]]; then
        local ip="${BASH_REMATCH[2]:-0}" fp="${BASH_REMATCH[3]}"
        _r="${BASH_REMATCH[1]}$((10#$ip))${fp:+.$fp}"; return
    fi
    _clyops_json_str "$v"
}

# Resolved values as JSON (spec section 10).
clyops_values_json() {
    local long kind rule i out=() item items
    for long in "${_CLYOPS_OPTS[@]}"; do
        kind="${_CLYOPS_KIND[$long]}"; rule="${_CLYOPS_RULE[$long]}"
        _clyops_json_str "${_CLYOPS_VAR[$long]}"; item="  $_r: "
        if [[ "$kind" == array ]]; then
            local -n _c_list="_CLYOPS_LIST_${_CLYOPS_INDEX[$long]}"
            items=()
            if [[ "${_CLYOPS_HAS[$long]:-}" ]]; then
                for i in "${_c_list[@]}"; do
                    if [[ -n "${_CLYOPS_SECRET[$long]:-}" ]]; then _r='"***"'; else _clyops_json_typed "$i" "$kind" "$rule"; fi
                    items+=("$_r")
                done
            fi
            unset -n _c_list
            local IFS=,; item+="[${items[*]}]"; unset IFS
        elif [[ "${_CLYOPS_HAS[$long]:-}" ]]; then
            if [[ -n "${_CLYOPS_SECRET[$long]:-}" ]]; then item+='"***"'
            elif [[ -z "${_CLYOPS_RAW[$long]}" ]]; then item+='""'
            else _clyops_json_typed "${_CLYOPS_RAW[$long]}" "$kind" "$rule"; item+="$_r"; fi
        else
            item+=null
        fi
        out+=("$item")
    done
    for (( i = 0; i < ${#_CLYOPS_ARGS[@]}; i++ )); do
        rule="${_CLYOPS_ARG_RULE[i]}"
        _clyops_json_str "${_CLYOPS_ARGS[i]}"; item="  $_r: "
        if [[ "$i" == "$_CLYOPS_VARIADIC" ]]; then
            items=()
            local v
            for v in "${_CLYOPS_REST[@]}"; do
                if [[ -z "$v" ]]; then items+=('""'); else _clyops_json_typed "$v" value "$rule"; items+=("$_r"); fi
            done
            local IFS=,; item+="[${items[*]}]"; unset IFS
        elif [[ -v "_CLYOPS_ARGV[i]" ]]; then
            if [[ -z "${_CLYOPS_ARGV[i]}" ]]; then item+='""'
            else _clyops_json_typed "${_CLYOPS_ARGV[i]}" value "$rule"; item+="$_r"; fi
        else
            item+=null
        fi
        out+=("$item")
    done
    if [[ -n "${_CLYOPS_CMD_KIDS[:]:-}" ]]; then
        items=()
        for i in $_CLYOPS_SEL; do _clyops_json_str "$i"; items+=("$_r"); done
        local IFS=,; out+=("  \"command\": [${items[*]}]"); unset IFS
    fi
    printf '{\n'
    local last=$(( ${#out[@]} - 1 ))
    for i in "${!out[@]}"; do
        if (( i < last )); then printf '%s,\n' "${out[i]}"; else printf '%s\n' "${out[i]}"; fi
    done
    printf '}\n'
}

# Greedy word wrap of $1 at width $2 into the array _CLYOPS_WRAPPED.
_clyops_wrap() {
    local text="$1" width="$2" para line word
    local -a words
    _CLYOPS_WRAPPED=()
    while IFS= read -r para || [[ -n "$para" ]]; do
        read -ra words <<< "$para"
        if (( ${#words[@]} == 0 )); then _CLYOPS_WRAPPED+=(""); continue; fi
        line=""
        for word in "${words[@]}"; do
            if [[ -z "$line" ]]; then line="$word"
            elif (( ${#line} + 1 + ${#word} <= width )); then line+=" $word"
            else _CLYOPS_WRAPPED+=("$line"); line="$word"; fi
        done
        _CLYOPS_WRAPPED+=("$line")
    done <<< "$text"
}

_clyops_label() { # help label of option $1 into _r
    local long="$1"
    if [[ -n "${_CLYOPS_SHORT[$long]}" ]]; then _r="-${_CLYOPS_SHORT[$long]}, --$long"; else _r="    --$long"; fi
    [[ "${_CLYOPS_KIND[$long]}" == flag ]] || _r+="=<value>"
}

_clyops_row() { # label text -> prints rows using _CLYOPS_INDENT/_CLYOPS_TEXTW
    local left="  $1" pad k
    if (( ${#left} < _CLYOPS_INDENT )); then
        printf -v pad '%*s' $(( _CLYOPS_INDENT - ${#left} )) ''; left+="$pad"
    else
        left+=" "
    fi
    _clyops_wrap "$2" "$_CLYOPS_TEXTW"
    printf -v pad '%*s' "$_CLYOPS_INDENT" ''
    _clyops_rtrim "$left${_CLYOPS_WRAPPED[0]}"
    for (( k = 1; k < ${#_CLYOPS_WRAPPED[@]}; k++ )); do _clyops_rtrim "$pad${_CLYOPS_WRAPPED[k]}"; done
}

_clyops_rtrim() { printf '%s\n' "${1%"${1##*[![:space:]]}"}"; }

_clyops_annotate() { # text notes... -> _r
    local text="$1"; shift
    if (( $# )); then
        local IFS=$'\x1f' joined
        joined="$*"
        _r="$text (${joined//$'\x1f'/, })"
    else
        _r="$text"
    fi
}

_clyops_stream_line() { # label description content-type
    local line="$1"
    [[ -n "$2" ]] && line+=" $2"
    [[ -n "$3" ]] && line+=" ($3)"
    echo "$line"
}

# Append option $1's relationship annotations (spec section 7) to the caller's notes.
_clyops_relation_notes() {
    local long="$1" i o list longs=()
    for (( i = 0; i < ${#_CLYOPS_CON_TYPE[@]}; i++ )); do
        [[ " ${_CLYOPS_CON_OPTS[i]} " == *" $long "* ]] || continue
        read -ra longs <<< "${_CLYOPS_CON_OPTS[i]}"
        list=""
        case "${_CLYOPS_CON_TYPE[i]}" in
            exclusive)
                for o in "${longs[@]}"; do [[ "$o" != "$long" ]] && list+="${list:+, }--$o"; done
                notes+=("conflicts with: $list") ;;
            requires)
                [[ "${longs[0]}" == "$long" ]] || continue
                for o in "${longs[@]:1}"; do list+="${list:+, }--$o"; done
                notes+=("requires: $list") ;;
            oneOf)
                for o in "${longs[@]}"; do list+="${list:+, }--$o"; done
                notes+=("one of: $list") ;;
        esac
    done
}

# Help text (spec section 7), for the selected command.
clyops_usage() {
    _clyops_ensure_help
    local maxw="${CLYOPS_MAX_WIDTH:-}" long longest=0 i notes=() usage group
    [[ "$maxw" =~ ^[0-9]+$ ]] && (( maxw > 0 )) || maxw=100
    for long in "${_CLYOPS_OPTS[@]}"; do
        _clyops_label "$long"; (( ${#_r} > longest )) && longest=${#_r}
    done
    local kids="${_CLYOPS_CMD_KIDS[:$_CLYOPS_SEL]:-}" kid
    for kid in $kids; do (( ${#kid} > longest )) && longest=${#kid}; done
    _CLYOPS_INDENT=$(( longest + 4 ))
    (( _CLYOPS_INDENT < 32 )) && _CLYOPS_INDENT=32
    (( _CLYOPS_INDENT > 50 )) && _CLYOPS_INDENT=50
    _CLYOPS_TEXTW=$(( maxw - _CLYOPS_INDENT ))
    (( _CLYOPS_TEXTW < 20 )) && _CLYOPS_TEXTW=20

    usage="Usage: ${_CLYOPS_NAME:-${0##*/}}${_CLYOPS_SEL:+ $_CLYOPS_SEL}"
    [[ -n "$kids" ]] && usage+=" <command>"
    for (( i = 0; i < ${#_CLYOPS_ARGS[@]}; i++ )); do
        if [[ "$i" == "$_CLYOPS_VARIADIC" ]]; then usage+=" [<${_CLYOPS_ARGS[i]}...>]"
        elif [[ -n "${_CLYOPS_ARG_DEFAULT[i]}" ]]; then usage+=" [<${_CLYOPS_ARGS[i]}>]"
        else usage+=" <${_CLYOPS_ARGS[i]}>"; fi
    done
    echo "$usage [OPTIONS]"

    if [[ -n "$_CLYOPS_DESCRIPTION" ]]; then
        echo
        _clyops_wrap "$_CLYOPS_DESCRIPTION" "$maxw"
        for i in "${_CLYOPS_WRAPPED[@]}"; do _clyops_rtrim "$i"; done
    fi

    if (( ${#_CLYOPS_STDIN[@]} + ${#_CLYOPS_STDOUT[@]} )); then
        echo
        (( ${#_CLYOPS_STDIN[@]} )) && _clyops_stream_line Input: "${_CLYOPS_STDIN[@]}"
        (( ${#_CLYOPS_STDOUT[@]} )) && _clyops_stream_line Output: "${_CLYOPS_STDOUT[@]}"
    fi

    if [[ -n "$kids" ]]; then
        printf '\nCommands:\n'
        for kid in $kids; do _clyops_row "$kid" "${_CLYOPS_CMD_ABOUT[:${_CLYOPS_SEL:+$_CLYOPS_SEL }$kid]}"; done
    fi

    if (( ${#_CLYOPS_ARGS[@]} )); then
        printf '\nPositional Arguments:\n'
        for (( i = 0; i < ${#_CLYOPS_ARGS[@]}; i++ )); do
            notes=()
            [[ "$i" == "$_CLYOPS_VARIADIC" ]] && notes+=(variadic)
            [[ -n "${_CLYOPS_ARG_DEFAULT[i]}" ]] && notes+=("default: ${_CLYOPS_ARG_DEFAULT[i]}")
            if [[ -n "${_CLYOPS_ARG_RULE[i]}" ]]; then _clyops_describe_rule "${_CLYOPS_ARG_RULE[i]}"; notes+=("accepts: $_r"); fi
            _clyops_annotate "${_CLYOPS_ARG_DESC[i]}" "${notes[@]}"
            _clyops_row "${_CLYOPS_ARGS[i]}" "$_r"
        done
    fi

    if (( ${#_CLYOPS_CMDS[@]} )); then
        printf '\nRequired Commands:\n'
        for (( i = 0; i < ${#_CLYOPS_CMDS[@]}; i++ )); do
            local status="not found" text="${_CLYOPS_CMD_DESC[i]}"
            type -P "${_CLYOPS_CMDS[i]}" >/dev/null && status=installed
            [[ -n "${_CLYOPS_CMD_HINT[i]}" ]] && text+=" (${_CLYOPS_CMD_HINT[i]})"
            _clyops_row "${_CLYOPS_CMDS[i]} [$status]" "$text"
        done
    fi

    local groups=() seen="" g
    for long in "${_CLYOPS_OPTS[@]}"; do
        g="${_CLYOPS_GROUP[$long]}"
        [[ "$seen" == *$'\x1f'"$g"$'\x1f'* ]] && continue
        seen+=$'\x1f'"$g"$'\x1f'; groups+=("$g")
    done
    for group in "${groups[@]}"; do
        printf '\n%s:\n' "$group"
        for long in "${_CLYOPS_OPTS[@]}"; do
            [[ "${_CLYOPS_GROUP[$long]}" == "$group" ]] || continue
            notes=()
            [[ "${_CLYOPS_REQUIRED[$long]}" ]] && notes+=(required)
            [[ "${_CLYOPS_KIND[$long]}" == array ]] && notes+=(multiple)
            [[ -n "${_CLYOPS_SECRET[$long]:-}" ]] && notes+=(secret)
            if [[ -v "_CLYOPS_CFG_VAL[$long]" ]]; then
                if [[ -n "${_CLYOPS_SECRET[$long]:-}" ]]; then notes+=("config: ***"); else notes+=("config: ${_CLYOPS_CFG_VAL[$long]}"); fi
            fi
            [[ -n "${_CLYOPS_DEFAULT[$long]}" ]] && notes+=("default: ${_CLYOPS_DEFAULT[$long]}")
            if [[ -n "${_CLYOPS_RULE[$long]}" ]]; then _clyops_describe_rule "${_CLYOPS_RULE[$long]}"; notes+=("accepts: $_r"); fi
            _clyops_relation_notes "$long"
            _clyops_annotate "${_CLYOPS_DESC[$long]}" "${notes[@]}"
            local text="$_r"
            _clyops_label "$long"
            _clyops_row "$_r" "$text"
        done
    done

    if [[ -n "$_CLYOPS_EPILOG" ]]; then
        echo
        local epilog="$_CLYOPS_EPILOG"
        while [[ "$epilog" == *$'\n' ]]; do epilog="${epilog%$'\n'}"; done
        while IFS= read -r i || [[ -n "$i" ]]; do _clyops_rtrim "$i"; done <<< "$epilog"
    fi
}

# JSON description of the CLI (spec section 8).
clyops_json_schema() {
    _clyops_ensure_help
    _clyops_json_str "${_CLYOPS_NAME:-${0##*/}}"; printf '{\n  "clyops": 1,\n  "script": %s,\n' "$_r"
    _clyops_schema_node ""
    printf '}\n'
}

_clyops_json_list() { # JSON array of the arguments into _r
    local items=() i
    for i in "$@"; do _clyops_json_str "$i"; items+=("$_r"); done
    local IFS=,; _r="[${items[*]}]"
}

_clyops_json_stream() { # (description content-type) or nothing -> JSON into _r
    if (( $# == 0 )); then _r=null; return; fi
    local d
    _clyops_json_str "$1"; d="$_r"; _clyops_json_str "$2"
    _r="{\"description\": $d, \"contentType\": $_r}"
}

# The fields of command $1 ("" for the program), which is selected; its
# commands are printed from subshells that select them in turn.
_clyops_schema_node() {
    local path="$1" i long rule type sep c choices kid
    _clyops_json_str "$_CLYOPS_DESCRIPTION"; printf '  "description": %s,\n' "$_r"
    _clyops_json_str "$_CLYOPS_EPILOG"; printf '  "epilog": %s,\n  "arguments": [' "$_r"
    sep=""
    for (( i = 0; i < ${#_CLYOPS_ARGS[@]}; i++ )); do
        local required=true variadic=false
        [[ "$i" == "$_CLYOPS_VARIADIC" ]] && { required=false; variadic=true; }
        [[ -n "${_CLYOPS_ARG_DEFAULT[i]}" ]] && required=false
        printf '%s\n    {\n' "$sep"
        _clyops_json_str "${_CLYOPS_ARGS[i]}"; printf '      "name": %s,\n' "$_r"
        _clyops_json_str "${_CLYOPS_ARG_DESC[i]}"; printf '      "description": %s,\n' "$_r"
        printf '      "required": %s,\n      "isVariadic": %s,\n' "$required" "$variadic"
        _clyops_json_str "${_CLYOPS_ARG_DEFAULT[i]}"; printf '      "default": %s,\n' "$_r"
        _clyops_json_str "${_CLYOPS_ARG_RULE[i]}"; printf '      "validation": %s\n    }' "$_r"
        sep=","
    done
    [[ -n "$sep" ]] && printf '\n  '
    printf '],\n  "options": ['
    sep=""
    for long in "${_CLYOPS_OPTS[@]}"; do
        [[ "${_CLYOPS_OWNER[$long]}" == "$path" ]] || continue
        rule="${_CLYOPS_RULE[$long]}"
        case "$rule" in
            bool) type=boolean ;; int|int:*|port) type=integer ;; float|float:*) type=number ;;
            choice:*) type=choice ;; path|file:*|dir:*) type=path ;; *) type=string ;;
        esac
        [[ "${_CLYOPS_KIND[$long]}" == flag ]] && type=boolean
        printf '%s\n    {\n' "$sep"
        _clyops_json_str "$long"; printf '      "name": %s,\n' "$_r"
        _clyops_json_str "${_CLYOPS_SHORT[$long]}"; printf '      "shortName": %s,\n' "$_r"
        _clyops_json_str "${_CLYOPS_VAR[$long]}"; printf '      "variableName": %s,\n' "$_r"
        _clyops_json_str "${_CLYOPS_DESC[$long]}"; printf '      "description": %s,\n' "$_r"
        if [[ "${_CLYOPS_KIND[$long]}" == flag ]]; then _r='"false"'; else _clyops_json_str "${_CLYOPS_DEFAULT[$long]}"; fi
        printf '      "default": %s,\n' "$_r"
        _clyops_json_str "${_CLYOPS_GROUP[$long]}"; printf '      "group": %s,\n' "$_r"
        printf '      "type": "%s",\n' "$type"
        printf '      "isFlag": %s,\n' "$([[ "${_CLYOPS_KIND[$long]}" == flag ]] && echo true || echo false)"
        printf '      "isArray": %s,\n' "$([[ "${_CLYOPS_KIND[$long]}" == array ]] && echo true || echo false)"
        printf '      "required": %s,\n' "$([[ "${_CLYOPS_REQUIRED[$long]}" ]] && echo true || echo false)"
        _clyops_json_str "$rule"; printf '      "validation": %s,\n' "$_r"
        choices=()
        if [[ "$rule" == choice:* ]]; then
            local IFS=,
            for c in ${rule#choice:}; do choices+=("$c"); done
            unset IFS
        fi
        _clyops_json_list "${choices[@]}"; printf '      "choices": %s,\n' "$_r"
        printf '      "secret": %s\n    }' "$([[ -n "${_CLYOPS_SECRET[$long]:-}" ]] && echo true || echo false)"
        sep=","
    done
    printf '\n  ],\n  "requiredCommands": ['
    sep=""
    for (( i = 0; i < ${#_CLYOPS_CMDS[@]}; i++ )); do
        [[ "${_CLYOPS_CMD_OWNER[i]}" == "$path" ]] || continue
        printf '%s\n    {\n' "$sep"
        _clyops_json_str "${_CLYOPS_CMDS[i]}"; printf '      "command": %s,\n' "$_r"
        _clyops_json_str "${_CLYOPS_CMD_DESC[i]}"; printf '      "description": %s,\n' "$_r"
        _clyops_json_str "${_CLYOPS_CMD_HINT[i]}"; printf '      "installHint": %s\n    }' "$_r"
        sep=","
    done
    [[ -n "$sep" ]] && printf '\n  '
    _clyops_json_list "${_CLYOPS_EFFECTS[@]}"; printf '],\n  "effects": %s,\n  "constraints": [' "$_r"
    sep=""
    for (( i = 0; i < ${#_CLYOPS_CON_TYPE[@]}; i++ )); do
        [[ "${_CLYOPS_CON_OWNER[i]}" == "$path" ]] || continue
        local -a longs
        read -ra longs <<< "${_CLYOPS_CON_OPTS[i]}"
        _clyops_json_list "${longs[@]}"
        printf '%s{"type": "%s", "options": %s}' "$sep" "${_CLYOPS_CON_TYPE[i]}" "$_r"
        sep=", "
    done
    _clyops_json_stream "${_CLYOPS_STDIN[@]}"; printf '],\n  "stdin": %s,\n' "$_r"
    _clyops_json_stream "${_CLYOPS_STDOUT[@]}"; printf '  "stdout": %s,\n  "commands": [' "$_r"
    sep=""
    for kid in ${_CLYOPS_CMD_KIDS[:$path]:-}; do
        _clyops_json_str "$kid"
        printf '%s{\n  "name": %s,\n' "$sep" "$_r"
        ( _clyops_enter "${path:+$path }$kid"; _clyops_schema_node "${path:+$path }$kid" )
        printf '}'
        sep=", "
    done
    printf ']\n'
}

_clyops_completion_kind() { # rule search-dirs -> _r "kind<TAB>values"
    local rule="$1" dirs="$2" kind=default values=""
    case "$rule" in
        path|file:*) kind="file"; values="$dirs" ;;
        dir:*) kind=dir; values="$dirs" ;;
        choice:*) kind=choice; values="${rule#choice:}" ;;
        bool) kind=choice; values="true,false" ;;
        hostname|ip) kind=host ;;
        "") ;;
        *) kind=none ;;
    esac
    _r="$kind"$'\t'"${values:--}"
}

# Tab-separated completion records (spec section 9). The arguments are the
# words typed after the program name; a program with commands follows them.
clyops_completion_data() {
    _clyops_ensure_help
    _clyops_abspath "${_CLYOPS_ROOT:-.}" "$PWD"
    _CLYOPS_ROOT_ABS="$_r"
    local long desc short i kid
    echo "#clyops-completion 1"
    if [[ -n "${_CLYOPS_CMD_KIDS[:]:-}" ]]; then
        _clyops_walk "$@"
        local skip="$_r" words=("$@")
        [[ -n "${_CLYOPS_CMD_KIDS[:$_CLYOPS_SEL]:-}" ]] && (( skip < $# )) && [[ "${words[skip]}" != -* ]] && return 0
        printf 'skip\t%s\n' "$skip"
        for kid in ${_CLYOPS_CMD_KIDS[:$_CLYOPS_SEL]:-}; do
            desc="${_CLYOPS_CMD_ABOUT[:${_CLYOPS_SEL:+$_CLYOPS_SEL }$kid]}"; desc="${desc//$'\t'/ }"; desc="${desc//$'\n'/ }"
            printf 'cmd\t%s\t%s\n' "$kid" "$desc"
        done
    fi
    for long in "${_CLYOPS_OPTS[@]}"; do
        desc="${_CLYOPS_DESC[$long]//$'\t'/ }"; desc="${desc//$'\n'/ }"
        short="${_CLYOPS_SHORT[$long]:+-${_CLYOPS_SHORT[$long]}}"
        if [[ "${_CLYOPS_KIND[$long]}" == flag ]]; then
            printf 'opt\t--%s\t%s\tflag\tnone\t-\t%s\n' "$long" "${short:--}" "$desc"
        else
            _clyops_search_dirs "$long"
            _clyops_completion_kind "${_CLYOPS_RULE[$long]}" "$_r"
            printf 'opt\t--%s\t%s\tvalue\t%s\t%s\n' "$long" "${short:--}" "$_r" "$desc"
        fi
        _clyops_is_bool_like "$long" && printf 'opt\t--no-%s\t-\tflag\tnone\t-\t%s\n' "$long" "$desc"
    done
    for (( i = 0; i < ${#_CLYOPS_ARGS[@]}; i++ )); do
        desc="${_CLYOPS_ARG_DESC[i]//$'\t'/ }"; desc="${desc//$'\n'/ }"
        _clyops_completion_kind "${_CLYOPS_ARG_RULE[i]}" ""
        printf 'arg\t%s\t%s\t%s\t%s\n' "${_CLYOPS_ARGS[i]}" "$([[ "$i" == "$_CLYOPS_VARIADIC" ]] && echo variadic || echo single)" "$_r" "$desc"
    done
}

# Print a script that enables completion for this program in bash, zsh or fish
# (spec section 9): eval "$(prog --completion bash)". Returns 1 for an unknown shell.
clyops_completion_script() {
    local template prog="${_CLYOPS_NAME:-${0##*/}}"
    case "$1" in
        bash) template="$_CLYOPS_COMPLETION_BASH" ;;
        zsh) template="$_CLYOPS_COMPLETION_ZSH" ;;
        fish) template="$_CLYOPS_COMPLETION_FISH" ;;
        *) return 1 ;;
    esac
    local func="${prog//[^A-Za-z0-9_]/_}"
    template="${template//__CLYOPS_FUNC__/$func}"
    printf '%s' "${template//__CLYOPS_PROG__/$prog}"
}

# BEGIN GENERATED COMPLETIONS (Generated by tools/sync-completions.py from spec/completions/. Do not edit.)
_CLYOPS_COMPLETION_BASH=$'# bash completion for __CLYOPS_PROG__ (generated by clyops)\n# Enable with:  eval "$(__CLYOPS_PROG__ --completion bash)"\n_clyops___CLYOPS_FUNC__() {\n    local cur="${COMP_WORDS[COMP_CWORD]}" prev="" data rec name short type kind values rest i skip=0\n    local -A otype=() okind=() ovalues=()\n    local -a names=() cmds=() akind=() avalues=() aarity=()\n    (( COMP_CWORD > 0 )) && prev="${COMP_WORDS[COMP_CWORD-1]}"\n    # The words before the cursor let a dispatcher answer for the subcommand being typed.\n    data=$("${COMP_WORDS[0]}" --bash-completion -- "${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null) || return 0\n    [[ "$data" == "#clyops-completion 1"* ]] || return 0\n\n    while IFS=$\'\\t\' read -r rec name short type kind values rest; do\n        [[ "$values" == - ]] && values=""\n        case "$rec" in\n            skip) skip="$name" ;;\n            cmd) cmds+=("$name") ;;\n            opt)\n                for i in "$name" "$short"; do\n                    [[ -z "$i" || "$i" == - ]] && continue\n                    names+=("$i"); otype[$i]="$type"; okind[$i]="$kind"; ovalues[$i]="$values"\n                done ;;\n            arg)\n                # arg records: name, arity, kind, values, description\n                [[ "$kind" == - ]] && kind=""\n                aarity+=("$short"); akind+=("$type"); avalues+=("$kind") ;;\n        esac\n    done <<< "$data"\n    # Words up to and including a dispatched subcommand belong to the dispatcher.\n    local first=$(( 1 + skip ))\n    (( COMP_CWORD <= first )) && prev=""\n\n    # Option value: --opt=VALUE (bash splits on "=") or --opt VALUE.\n    local opt=""\n    if [[ "$cur" == --*=* ]]; then opt="${cur%%=*}"; cur="${cur#*=}"\n    elif [[ "$cur" == = && "${otype[$prev]}" == value ]]; then opt="$prev"; cur=""\n    elif [[ "$prev" == = ]] && (( COMP_CWORD > first + 1 )); then opt="${COMP_WORDS[COMP_CWORD-2]}"\n    elif [[ "$prev" == -* && "${otype[$prev]}" == value ]]; then opt="$prev"\n    fi\n    if [[ -n "$opt" ]]; then\n        _clyops_value___CLYOPS_FUNC__ "${okind[$opt]}" "${ovalues[$opt]}" "$cur"\n        return 0\n    fi\n\n    if [[ "$cur" == -* ]]; then\n        COMPREPLY=($(compgen -W "${names[*]}" -- "$cur"))\n        return 0\n    fi\n\n    # A dispatcher group: complete its subcommands.\n    if (( ${#cmds[@]} )); then\n        COMPREPLY=($(compgen -W "${cmds[*]}" -- "$cur"))\n        return 0\n    fi\n\n    # A dispatched program without completion data: fall back to file names.\n    if (( skip > 0 && ${#names[@]} == 0 && ${#akind[@]} == 0 )); then\n        compopt -o default 2>/dev/null\n        COMPREPLY=()\n        return 0\n    fi\n\n    # Positional: count earlier positionals, skipping options and their values.\n    local pos=0 endopts="" w\n    for (( i = first; i < COMP_CWORD; i++ )); do\n        w="${COMP_WORDS[i]}"\n        if [[ -z "$endopts" && "$w" == -- ]]; then endopts=1\n        elif [[ -z "$endopts" && "$w" == -?* ]]; then\n            [[ "$w" != *=* && "${otype[$w]}" == value ]] && (( i++ ))\n        elif [[ "$w" != = ]]; then (( pos++ ))\n        fi\n    done\n    local n=${#akind[@]}\n    (( n == 0 )) && return 0\n    if (( pos >= n )); then\n        [[ "${aarity[n-1]}" == variadic ]] || return 0\n        pos=$(( n - 1 ))\n    fi\n    _clyops_value___CLYOPS_FUNC__ "${akind[pos]}" "${avalues[pos]}" "$cur"\n}\n\n_clyops_value___CLYOPS_FUNC__() {\n    local kind="$1" values="$2" cur="$3" dir IFS=$\'\\n\'\n    case "$kind" in\n        choice) COMPREPLY=($(IFS=$\' \\t\\n\'; compgen -W "${values//,/ }" -- "$cur")) ;;\n        file|dir)\n            local flag=-f\n            [[ "$kind" == dir ]] && flag=-d\n            compopt -o filenames 2>/dev/null\n            COMPREPLY=($(compgen $flag -- "$cur"))\n            # Bare names also match entries in the option\'s search dirs.\n            if [[ -n "$values" && "$cur" != /* && "$cur" != ./* && "$cur" != ../* ]]; then\n                local -a dirs\n                IFS=: read -ra dirs <<< "$values"\n                for dir in "${dirs[@]}"; do\n                    [[ -d "$dir" ]] && COMPREPLY+=($(cd "$dir" && compgen $flag -- "$cur"))\n                done\n            fi ;;\n        host) COMPREPLY=($(compgen -A hostname -- "$cur")) ;;\n        none) COMPREPLY=() ;;\n        *) compopt -o default 2>/dev/null; COMPREPLY=() ;;\n    esac\n}\n\ncomplete -F _clyops___CLYOPS_FUNC__ __CLYOPS_PROG__\n'
_CLYOPS_COMPLETION_ZSH=$'#compdef __CLYOPS_PROG__\n# zsh completion for __CLYOPS_PROG__ (generated by clyops)\n# Enable with:  eval "$(__CLYOPS_PROG__ --completion zsh)"\n#   or install:  __CLYOPS_PROG__ --completion zsh > "${fpath[1]}/___CLYOPS_PROG__"\n_clyops___CLYOPS_FUNC__() {\n    local data line esc action skip=0\n    local -a f specs cmds\n    # The words before the cursor let a dispatcher answer for the subcommand being typed.\n    data=$("${words[1]}" --bash-completion -- "${(@)words[2,CURRENT-1]}" 2>/dev/null) || return 1\n    [[ "$data" == "#clyops-completion 1"* ]] || return 1\n\n    for line in "${(@f)data}"; do\n        [[ "$line" == \\#* ]] && continue\n        f=("${(@ps:\\t:)line}")\n        if [[ "$f[1]" == skip ]]; then\n            skip=$f[2]\n        elif [[ "$f[1]" == cmd ]]; then\n            cmds+=("${f[2]//:/\\\\:}:$f[3]")\n        elif [[ "$f[1]" == opt ]]; then\n            esc="${${${${f[7]//\\\\/\\\\\\\\}//\\[/\\\\[}//\\]/\\\\]}//:/\\\\:}"\n            if [[ "$f[4]" == flag ]]; then\n                specs+=("$f[2][$esc]")\n                [[ "$f[3]" != - ]] && specs+=("$f[3][$esc]")\n                continue\n            fi\n            action="$(_clyops_action___CLYOPS_FUNC__ "$f[5]" "$f[6]")"\n            specs+=("$f[2]=[$esc]:value:$action")\n            [[ "$f[3]" != - ]] && specs+=("$f[3]+[$esc]:value:$action")\n        elif [[ "$f[1]" == arg ]]; then\n            esc="${${f[6]//\\\\/\\\\\\\\}//:/\\\\:}"\n            action="$(_clyops_action___CLYOPS_FUNC__ "$f[4]" "$f[5]")"\n            if [[ "$f[3]" == variadic ]]; then specs+=("*:$esc:$action"); else specs+=(":$esc:$action"); fi\n        fi\n    done\n    # Past a dispatched subcommand, complete its words as if they were the whole line.\n    if (( skip )); then\n        words=("${words[1]}" "${(@)words[2+skip,-1]}")\n        (( CURRENT -= skip ))\n    fi\n    # A dispatcher group: complete its subcommands.\n    if (( ${#cmds} )) && [[ "${words[CURRENT]}" != -* ]]; then\n        _describe -t commands command cmds\n        return\n    fi\n    # A dispatched program without completion data: fall back to file names.\n    if (( skip && ${#specs} == 0 )); then\n        _files\n        return\n    fi\n    _arguments -s -S : "${specs[@]}"\n}\n\n_clyops_action___CLYOPS_FUNC__() {\n    local kind="$1" values="$2"\n    [[ "$values" == - ]] && values=""\n    case "$kind" in\n        choice) print -r -- "(${values//,/ })" ;;\n        file) if [[ -n "$values" ]]; then print -r -- "{_files; _files -W \\"(${values//:/ })\\"}"; else print -r -- _files; fi ;;\n        dir) if [[ -n "$values" ]]; then print -r -- "{_files -/; _files -/ -W \\"(${values//:/ })\\"}"; else print -r -- "_files -/"; fi ;;\n        host) print -r -- _hosts ;;\n        none) print -r -- " " ;;\n        *) print -r -- _files ;;\n    esac\n}\n\nif [[ "${zsh_eval_context[-1]}" == loadautofunc ]]; then\n    _clyops___CLYOPS_FUNC__ "$@"\nelse\n    compdef _clyops___CLYOPS_FUNC__ __CLYOPS_PROG__\nfi\n'
_CLYOPS_COMPLETION_FISH=$'# fish completion for __CLYOPS_PROG__ (generated by clyops)\n# Enable with:  __CLYOPS_PROG__ --completion fish | source\n#   or install:  __CLYOPS_PROG__ --completion fish > ~/.config/fish/completions/__CLYOPS_PROG__.fish\nfunction __clyops___CLYOPS_FUNC___value --argument-names kind values cur\n    switch $kind\n        case choice\n            string split , -- $values\n        case file\n            __fish_complete_path $cur\n            # Bare names also match entries in the option\'s search dirs.\n            if test -n "$values"; and not string match -qr -- \'^(/|\\./|\\.\\./)\' $cur\n                for dir in (string split : -- $values)\n                    for f in $dir/$cur*\n                        string replace -- "$dir/" \'\' $f\n                    end\n                end\n            end\n        case dir\n            __fish_complete_directories $cur\n        case host\n            __fish_print_hostnames\n        case none\n        case \'*\'\n            __fish_complete_path $cur\n    end\nend\n\nfunction __clyops___CLYOPS_FUNC___complete\n    set -l tokens (commandline -opc)\n    set -l cur (commandline -ct)\n    # The words before the cursor let a dispatcher answer for the subcommand being typed.\n    set -l data (command $tokens[1] --bash-completion -- $tokens[2..-1] 2>/dev/null)\n    string match -q \'#clyops-completion 1\' -- $data[1]; or return\n\n    set -l skip 0\n    set -l cmds\n    set -l onames; set -l otypes; set -l okinds; set -l ovalues; set -l odescs\n    set -l akinds; set -l avalues; set -l aarity\n    for line in $data[2..-1]\n        set -l f (string split \\t -- $line)\n        switch $f[1]\n            case skip\n                set skip $f[2]\n            case cmd\n                set -a cmds "$f[2]"\\t"$f[3]"\n            case opt\n                # "-" marks an empty field.\n                set -l values $f[6]\n                test "$values" = -; and set values \'\'\n                for n in $f[2] $f[3]\n                    test "$n" = -; and continue\n                    set -a onames $n; set -a otypes $f[4]; set -a okinds $f[5]; set -a ovalues "$values"; set -a odescs "$f[7]"\n                end\n            case arg\n                set -l values $f[5]\n                test "$values" = -; and set values \'\'\n                set -a aarity $f[3]; set -a akinds $f[4]; set -a avalues "$values"\n        end\n    end\n    # Words up to and including a dispatched subcommand belong to the dispatcher.\n    set -l words $tokens[(math $skip + 2)..-1]\n\n    # --opt=VALUE\n    if string match -qr -- \'^--[^=]+=\' $cur\n        set -l opt (string replace -r \'=.*\' \'\' -- $cur)\n        set -l i (contains -i -- $opt $onames)\n        if test -n "$i"; and test "$otypes[$i]" = value\n            for v in (__clyops___CLYOPS_FUNC___value $okinds[$i] "$ovalues[$i]" (string replace -r \'^[^=]*=\' \'\' -- $cur))\n                echo "$opt=$v"\n            end\n        end\n        return\n    end\n    # --opt VALUE\n    if test (count $words) -gt 0\n        set -l i (contains -i -- $words[-1] $onames)\n        if test -n "$i"; and test "$otypes[$i]" = value\n            __clyops___CLYOPS_FUNC___value $okinds[$i] "$ovalues[$i]" $cur\n            return\n        end\n    end\n    if string match -q -- \'-*\' $cur\n        for i in (seq (count $onames))\n            echo $onames[$i]\\t$odescs[$i]\n        end\n        return\n    end\n    # A dispatcher group: complete its subcommands.\n    if test (count $cmds) -gt 0\n        printf \'%s\\n\' $cmds\n        return\n    end\n    # A dispatched program without completion data: fall back to file names.\n    if test $skip -gt 0; and test (count $onames) -eq 0; and test (count $akinds) -eq 0\n        __fish_complete_path $cur\n        return\n    end\n    # Positional: count earlier positionals, skipping options and their values.\n    set -l pos 0\n    set -l skipnext 0\n    set -l endopts 0\n    for w in $words\n        if test $skipnext -eq 1\n            set skipnext 0\n        else if test $endopts -eq 0; and test "$w" = --\n            set endopts 1\n        else if test $endopts -eq 0; and string match -q -- \'-?*\' $w\n            set -l i (contains -i -- $w $onames)\n            test -n "$i"; and test "$otypes[$i]" = value; and set skipnext 1\n        else\n            set pos (math $pos + 1)\n        end\n    end\n    set -l n (count $akinds)\n    test $n -eq 0; and return\n    if test $pos -ge $n\n        test "$aarity[$n]" = variadic; or return\n        set pos (math $n - 1)\n    end\n    set -l k (math $pos + 1)\n    __clyops___CLYOPS_FUNC___value $akinds[$k] "$avalues[$k]" $cur\nend\n\ncomplete -c __CLYOPS_PROG__ -f -a \'(__clyops___CLYOPS_FUNC___complete)\'\n'
# END GENERATED COMPLETIONS
