---
title: Ruby
---
# Ruby

Requires **Ruby 3.1+**. [Complete API reference](/reference/ruby/index.html) · [Shared behavior](../guide.md)

## Install and run

```sh
gem install clyops
```

Save the following as `quickstart.rb`:

<!-- example: quickstart.rb -->
```ruby
require "clyops"

cli = Clyops::Cli.new(name: "docs-demo")
cli.opt "NAME", "name", "n", "World", "Who to greet"
cli.opt "COUNT", "count", "c", "1", "Repeat count", "Options", "int:1-3"
cli.opt "VERBOSE", "verbose", "v", "flag", "Verbose output"
args = cli.run
puts "#{args.NAME} #{args.COUNT} #{args.VERBOSE}"
```

```sh
ruby quickstart.rb --name Ada --count 2 --verbose
# Ada 2 true
ruby quickstart.rb --help
ruby quickstart.rb --help-json-schema
ruby quickstart.rb --count invalid
# Validation error; exit status 1
```

## Editor support and resolved values

YARD comments describe public methods and parameter/result types. The gem includes `sig/clyops.rbs` for tools that consume RBS. Editor support differs by language server; dynamic `args.NAME` access cannot imply a specific registered field type.

## Commands, relationships, secrets, effects and I/O

Add these registrations before calling `run`. A CLI level has either subcommands or positional arguments.

```ruby
db = cli.command("db", "Database tasks")                # a command: mytool db ...
migrate = db.command("migrate", "Apply migrations")     # mytool db migrate
migrate.opt "TO", "to", "", "optional", "Target version", "Options", "int"
migrate.set_effects("destructive")                      # read-only, idempotent, destructive, network
cli.opt "TOKEN", "token", "t", "", "API token", "Auth", "secret"  # masked in help and values_json
cli.exclusive("json", "quiet")                          # also requires(a, b...) and one_of(a, b...)
cli.set_stdin("Audio to transcribe", "audio/wav")       # and set_stdout(description, content_type)
cli.fd(4, "out", "Progress", "application/x-ndjson", "progress")  # then cli.emit("progress", { pct: 50 })
args = cli.run                                          # args.command == ["db", "migrate"]
```

`cli.command_path` is the selected command words. Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.

## Parsing and errors

Use `run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
