# clyops (Python)

One-line-per-option CLI parsing with validation, help text, config files, JSON schema, logging and
shell completion. Pure standard library, Python 3.9+. See the
[main README](https://github.com/wankdanker/clyops).

```python
#!/usr/bin/env python3
from clyops import Cli, info

cli = Cli()
cli.set_description("Copy files to a server.")
cli.arg("SRC", "File to send", "", "file:exists")
cli.arg_variadic("EXTRA", "More files", "file:exists")
cli.opt("HOST", "host", "H", "localhost", "Server", "Network", "hostname")
cli.opt("PORT", "port", "p", "22", "Port", "Network", "port")
cli.opt("VERBOSE", "verbose", "v", "flag", "Chatty")
cli.opt("CONFIG", "config", "c", "optional", "Config file", "Config", "path")
cli.set_config("config", "send:")
args = cli.run()

info(f"sending {args.SRC} to {args.HOST}:{args.PORT}")
```

`group` and `rule` can also be passed by keyword (`rule="port"`). `run()` returns a dict of typed
values that also allows attribute access; `parse()` is the non-exiting variant and returns a
`ParseResult`. Also: `source`, `is_set`, `is_explicitly_set`, `usage`, `json_schema`,
`completion_script`, `values_json`, `set_path_search`, `require_command`, and the logging helpers
`info`, `warn`, `error`, `success`, `die`.

## Commands, relationships, secrets, effects and I/O

```python
db = cli.command("db", "Database tasks")                # a command: mytool db ...
migrate = db.command("migrate", "Apply migrations")     # mytool db migrate
migrate.opt("TO", "to", "", "optional", "Target version", rule="int")
migrate.set_effects("destructive")                      # read-only, idempotent, destructive, network
cli.opt("TOKEN", "token", "t", "", "API token", "Auth", "secret")  # masked in help and values_json()
cli.exclusive("json", "quiet")                          # also requires(a, b...) and one_of(a, b...)
cli.set_stdin("Audio to transcribe", "audio/wav")       # and set_stdout(description, content_type)
args = cli.run()                                        # args.command == ["db", "migrate"]
```

`cli.command_path` is the selected command words. Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.
