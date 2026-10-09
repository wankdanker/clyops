# clyops (Ruby)

One-line-per-option CLI parsing with validation, help text, config files, JSON schema, logging and
shell completion. Standard library only, Ruby 3.1+. See the
[main README](https://github.com/wankdanker/clyops).

```sh
gem install clyops
```

```ruby
#!/usr/bin/env ruby
require "clyops"

cli = Clyops::Cli.new
cli.set_description("Copy files to a server.")
cli.arg          "SRC",   "File to send", "", "file:exists"
cli.arg_variadic "EXTRA", "More files", "file:exists"
cli.opt "HOST",    "host",    "H", "localhost", "Server",      "Network", "hostname"
cli.opt "PORT",    "port",    "p", "22",        "Port",        "Network", "port"
cli.opt "VERBOSE", "verbose", "v", "flag",      "Chatty"
cli.opt "CONFIG",  "config",  "c", "optional",  "Config file", "Config",  "path"
cli.set_config("config", "send:")
args = cli.run

Clyops.info("sending #{args.SRC} to #{args.HOST}:#{args.PORT}")
```

`opt(var, long, short, default, description, group, rule)`: `default` is a value, `"flag"`,
`"optional"`, or `""` for a required option; `opt_array` registers a repeatable one. `run` handles
`--help`, `--help-json-schema` and `--completion`, prints errors and exits, and returns a Hash of
typed values (Integer, Float, true/false, String, Array) that also reads as methods (`args.PORT`).
`parse(argv)` is the non-exiting variant and returns a `ParseResult`.

Also: `source`, `set?`, `explicitly_set?`, `usage`, `json_schema`, `completion_script`,
`values_json`, `set_path_search`, `require_command`, `Clyops.validate`, `Clyops.resolve_path`,
`Clyops.describe_rule`, `Clyops.wrap_text`, and the logging helpers `Clyops.info`, `warn`,
`error`, `success`, `die` and `silent=`. Registration mistakes (an unknown rule, a duplicate
option) raise `Clyops::DefinitionError`.

Shell completion: `eval "$(mytool --completion bash)"` (or `zsh`, `fish`).
