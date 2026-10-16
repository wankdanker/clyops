# clyops in Python

Python 3.9+, standard library only.

## Install

```sh
python -m pip install clyops
```

`import clyops` or `from clyops import …` is what makes the dispatcher, API
and MCP server recognize the tool.

## Registration

```python
from clyops import Cli, info, die

cli = Cli(name="plan")                    # also root=...
cli.opt(VAR, long, short, default, description, group="Options", rule="")
cli.opt_array(VAR, long, short, description, group="Options", rule="")
cli.arg(NAME, description, default="", rule="")
cli.arg_variadic(NAME, description, rule="")
```

`group` and `rule` can be positional or keyword arguments. Metadata:
`set_description`, `set_epilog`, `set_config(option, prefixes)`,
`set_path_search(long, dirs)`, `require_command(cmd, description, hint)`,
`set_effects(*effects)`, `set_stdin(description, content_type)`,
`set_stdout(description, content_type)`, `exclusive(*longs)`,
`requires(*longs)`, `one_of(*longs)`, `command(name, description)`.

## Values

`args = cli.run()` returns an object with attribute access by variable or
argument name (`args.PORT`). Values are typed: `int*`/`port` → `int`,
`float*` → `float`, flags/`bool` → `bool`, arrays → `list`, unset → `None`.
`args.command` (or `cli.command_path`) is the selected command words.

Also `cli.source(long)`, `cli.values_json()`, and non-exiting `cli.parse(argv)`.

## Logging

`info`, `warn`, `error`, `success` take a rendered string (use f-strings);
`die(code, message)` logs and exits.

## Example

```python
#!/usr/bin/env python3
"""Plan a deployment without changing anything."""
import json

from clyops import Cli

cli = Cli(name="plan")
cli.set_description("Build a deployment plan. Change nothing.")
cli.opt("SERVICE", "service", "s", "api", "Service", rule="choice:api,worker")
cli.opt("ENV", "env", "e", "staging", "Environment", rule="choice:staging,production")
cli.opt("REPLICAS", "replicas", "r", "2", "Replica count", rule="int:1-10")
cli.opt_array("TAG", "tag", "t", "Labels to attach", rule="string:1-40")
cli.opt("WEBHOOK", "webhook", "", "optional", "Notify this webhook", "Notification", "url")
cli.opt("EMAIL", "email", "", "optional", "Notify this email address", "Notification", "email")
cli.exclusive("webhook", "email")
cli.set_effects("read-only")
cli.set_stdout("Deployment plan", "application/json")
args = cli.run()

# Our tool's logic starts here, after the interface is fully declared.
print(json.dumps({"service": args.SERVICE, "env": args.ENV,
                  "replicas": args.REPLICAS, "tags": args.TAG}))
```

## Commands

```python
cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output", "Global")  # program options first
db = cli.command("db", "Database tasks")
db.opt("DB_URL", "url", "u", "sqlite:app.db", "Database URL", "Database")
migrate = db.command("migrate", "Apply migrations")
migrate.arg("target", "Target version", "latest")
migrate.opt("DRY_RUN", "dry-run", "n", "flag", "Show what would run")
migrate.set_effects("destructive")
db.command("status", "Show migration status").set_effects("read-only")
args = cli.run()
if args.command == ["db", "migrate"]:
    ...
```
