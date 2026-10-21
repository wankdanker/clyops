---
title: Python
---
# Python

Requires **Python 3.9+**. [Complete API reference](/reference/python/clyops.html) · [Shared behavior](../guide.md)

## Install and run

```sh
python -m pip install clyops
```

Save the following as `quickstart.py`:

<!-- example: quickstart.py -->
```python
from clyops import Cli

cli = Cli(name="docs-demo")
cli.opt("NAME", "name", "n", "World", "Who to greet")
cli.opt("COUNT", "count", "c", "1", "Repeat count", rule="int:1-3")
cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output")
args = cli.run()
print(f"{args.NAME} {args.COUNT} {str(args.VERBOSE).lower()}")
```

```sh
python quickstart.py --name Ada --count 2 --verbose
# Ada 2 true
python quickstart.py --help
python quickstart.py --help-json-schema
python quickstart.py --count invalid
# Validation error; exit status 1
```

## Editor support and resolved values

PyCharm, Pylance and mypy can read the inline annotations. The wheel contains `py.typed`. Resolved values have a scalar/list/None union; dynamic attribute names are not inferred from runtime registrations. Narrow values before numeric work, or map them into your own typed application model.

## Commands, relationships, secrets, effects and I/O

Add these registrations before calling `run`. A CLI level has either subcommands or positional arguments.

```python
db = cli.command("db", "Database tasks")                # a command: mytool db ...
migrate = db.command("migrate", "Apply migrations")     # mytool db migrate
migrate.opt("TO", "to", "", "optional", "Target version", rule="int")
migrate.set_effects("destructive")                      # read-only, idempotent, destructive, network
cli.opt("TOKEN", "token", "t", "", "API token", "Auth", "secret")  # masked in help and values_json()
cli.opt("JSON", "json", "", "flag", "JSON output")
cli.opt("QUIET", "quiet", "", "flag", "Quiet output")
cli.exclusive("json", "quiet")                          # also requires(a, b...) and one_of(a, b...)
cli.set_stdin("Audio to transcribe", "audio/wav")       # and set_stdout(description, content_type)
cli.role("progress", "out", "Progress", "application/x-ndjson")  # then cli.emit("progress", {"pct": 50})
args = cli.run()                                        # args.command == ["db", "migrate"]
```

`cli.command_path` is the selected command words. Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.

## Parsing and errors

Use `run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
