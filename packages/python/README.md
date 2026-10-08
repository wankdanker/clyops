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
