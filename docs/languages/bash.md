---
title: Bash
---
# Bash

Requires **Bash 4.3+**. [Complete API reference](/reference/bash.html) · [Shared behavior](../guide.md)

## Install and run

```sh
curl -fsSLo clyops.sh https://raw.githubusercontent.com/wankdanker/clyops/v0.9.0/packages/bash/clyops.sh
```

Save the following as `quickstart.sh`:

<!-- example: quickstart.sh -->
```bash
#!/usr/bin/env bash
source "${CLYOPS_LIBRARY:-./clyops.sh}"
clyops_name docs-demo
clyops_opt NAME name n World "Who to greet"
clyops_opt COUNT count c 1 "Repeat count" Options int:1-3
clyops_opt VERBOSE verbose v flag "Verbose output"
clyops_run "$@"
printf '%s %s %s\n' "$NAME" "$COUNT" "$VERBOSE"
```

```sh
bash quickstart.sh --name Ada --count 2 --verbose
# Ada 2 true
bash quickstart.sh --help
bash quickstart.sh --help-json-schema
bash quickstart.sh --count invalid
# Validation error; exit status 1
```

## Editor support and resolved values

Bash Language Server can navigate sourced functions and their usage comments. Bash has no portable static type-declaration format. Use the reference for parameter conventions, array outputs and exit statuses.

## Commands, relationships, secrets, effects and I/O

Add these registrations before calling `run`. A CLI level has either subcommands or positional arguments.

```bash
clyops_opt     TOKEN token t "" "API token" Auth secret   # masked in help and clyops_values_json
clyops_exclusive json quiet                               # also clyops_requires a b..., clyops_one_of a b...
clyops_stdin   "Audio to transcribe" audio/wav            # and clyops_stdout description content-type
clyops_role    progress out "Progress" application/x-ndjson    # then clyops_emit progress '{"pct":50}'
clyops_effects read-only                                  # read-only, idempotent, destructive, network
clyops_command db "Database tasks"                        # later registrations belong to db...
clyops_command "db migrate" "Apply migrations"            # ...then to db migrate
clyops_opt     TO to "" optional "Target version" Options int
clyops_run "$@"                                           # CLYOPS_COMMAND=(db migrate)
```

A command's registrations are recorded and made when the command is selected, so sibling commands can reuse option names; register the program's own options before its commands. Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.

## Parsing and errors

Use `clyops_run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `clyops_parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
