#!/usr/bin/env bash
# The conformance demo CLI (spec/conformance/README.md) in Bash.
source "$(dirname "${BASH_SOURCE[0]}")/../clyops.sh"

clyops_name demo
clyops_root "${DEMO_ROOT:-$PWD}"
clyops_description "Demo program for the clyops conformance suite. It registers one of every kind of option and argument so that each implementation can be checked against the same help text, schema and resolved values."
clyops_epilog $'Examples:\n  demo in.txt slow a b --tag x --tag y\n  demo in.txt -vc demo.conf'
clyops_require_command sh "POSIX shell" "install dash"
clyops_effects idempotent network
clyops_stdin  "Lines to process" text/plain
clyops_stdout "The resolved values" application/json

clyops_arg          input "Input file" "" path
clyops_arg          mode  "Processing mode" fast "choice:fast,slow"
clyops_arg_variadic rest  "Extra items"

clyops_opt       CONFIG   config   c optional  "Config file to load"   Config     path
clyops_opt       VERBOSE  verbose  v flag      "Enable verbose output" Output
clyops_opt       QUIET    quiet    q flag      "Suppress output"       Output
clyops_opt       COLOR    color    "" auto     "When to use color"     Output     "choice:auto,always,never"
clyops_opt       OUT      out      o out.txt   "Output path"           Output     path
clyops_opt       NOTES    notes    "" optional "Free-form notes. This description is deliberately long so that the help output has to wrap it onto several lines at the default width of one hundred columns." Output
clyops_opt       COUNT    count    n 3         "Number of iterations"  Options    "int:1-10"
clyops_opt       RATIO    ratio    "" 0.5      "Mix ratio"             Options    "float:0-1"
clyops_opt       ENABLED  enabled  "" true     "Enable processing"     Options    bool
clyops_opt_array TAG      tag      t           "Tag to attach"         Options    "string:1-8"
clyops_opt       NO_CACHE no-cache "" flag     "Disable the cache"     Options
clyops_opt       KEY      key      k ""        "API key"               Auth       secret
clyops_opt       HOST     host     H localhost "Server host"           Network    hostname
clyops_opt       PORT     port     p 8080      "Server port"           Network    port
clyops_opt       ENDPOINT endpoint "" optional "Endpoint URL"          Network    url
clyops_opt       ADDR     addr     "" optional "Bind address"          Network    ip
clyops_opt       ID       id       "" optional "Request identifier"    Validation uuid
clyops_opt       EMAIL    email    "" optional "Contact email"         Validation email
clyops_opt       DATE     date     "" optional "Start date"            Validation "date:YYYY-MM-DD"
clyops_opt       CODE     code     "" optional "Three-letter code"     Validation 'regex:^[A-Z]{3}$'
clyops_opt       LEVEL    level    "" optional "Level"                 Validation int
clyops_opt       SIZE     size     "" optional "Size code"             Validation "string:4"
clyops_opt       DATA_DIR data-dir d optional  "Data directory"        Files      "dir:exists"
clyops_opt       SRC      src      "" optional "Source file"           Files      "file:exists"
clyops_opt       DEST     dest     "" optional "Destination file"      Files      "file:writable"
clyops_opt_array INCLUDE  include  I           "Include directory"     Files      path

clyops_config      config "demo:,shared:"
clyops_path_search config conf
clyops_exclusive   endpoint addr
clyops_requires    dest src

clyops_run "$@"

sources=""
for long in config verbose quiet color out notes count ratio enabled tag no-cache key host port endpoint addr id email date code level size data-dir src dest include help; do
    sources+="${sources:+, }\"$long\": \"$(clyops_source "$long")\""
done
printf '{"values": %s, "sources": {%s}}\n' "$(clyops_values_json)" "$sources"
