# clyops in Ruby

Ruby 3.1+, standard library only.

## Install

```sh
gem install clyops
```

**Ruby tools are not recognized automatically** by the dispatcher, API or MCP
server. Put an exact standalone `# clyops-tool` comment within the first ten
lines (right after the shebang), or the tool gets no description and is not
offered as an API/MCP tool.

## Registration

```ruby
require "clyops"

cli = Clyops::Cli.new(name: "plan")           # also root: ...
cli.opt VAR, long, short, default, description, group = "Options", rule = ""
cli.opt_array VAR, long, short, description, group = "Options", rule = ""
cli.arg NAME, description, default = "", rule = ""
cli.arg_variadic NAME, description, rule = ""
```

`group` and `rule` are positional. Metadata: `set_description`, `set_epilog`,
`set_config(option, prefixes)`, `set_path_search(long, dirs)`,
`require_command(cmd, description, hint)`, `set_effects(*effects)`,
`set_stdin(description, content_type)`, `set_stdout(description,
content_type)`, `exclusive(*longs)`, `requires(*longs)`, `one_of(*longs)`,
`command(name, description)`.

## Values

`args = cli.run` returns an object with method access by variable or argument
name (`args.PORT`). Values are typed (`Integer`, `Float`, `true`/`false`,
`Array`, `nil` when unset). `args.command` (or `cli.command_path`) is the
selected command words.

Also `cli.source(long)`, `cli.set?(long)`, `cli.explicitly_set?(long)`,
`cli.values_json`, and non-exiting `cli.parse(argv)`.

## Logging

`Clyops.info`, `Clyops.warn`, `Clyops.error`, `Clyops.success` take a rendered
string; `Clyops.die(code, message)` logs and exits.

## Example

```ruby
#!/usr/bin/env ruby
# clyops-tool
# frozen_string_literal: true

require "clyops"
require "json"

cli = Clyops::Cli.new(name: "plan")
cli.set_description("Build a deployment plan. Change nothing.")
cli.opt "SERVICE", "service", "s", "api", "Service", "Options", "choice:api,worker"
cli.opt "ENV", "env", "e", "staging", "Environment", "Options", "choice:staging,production"
cli.opt "REPLICAS", "replicas", "r", "2", "Replica count", "Options", "int:1-10"
cli.opt_array "TAG", "tag", "t", "Labels to attach", "Options", "string:1-40"
cli.opt "WEBHOOK", "webhook", "", "optional", "Notify this webhook", "Notification", "url"
cli.opt "EMAIL", "email", "", "optional", "Notify this email address", "Notification", "email"
cli.exclusive("webhook", "email")
cli.set_effects("read-only")
cli.set_stdout("Deployment plan", "application/json")
args = cli.run

# Our tool's logic starts here, after the interface is fully declared.
puts JSON.generate({ service: args.SERVICE, env: args.ENV, replicas: args.REPLICAS, tags: args.TAG })
```

## Commands

```ruby
cli.opt "VERBOSE", "verbose", "v", "flag", "Verbose output", "Global"   # program options first
db = cli.command("db", "Database tasks")
db.opt "DB_URL", "url", "u", "sqlite:app.db", "Database URL", "Database"
migrate = db.command("migrate", "Apply migrations")
migrate.arg "target", "Target version", "latest"
migrate.opt "DRY_RUN", "dry-run", "n", "flag", "Show what would run"
migrate.set_effects("destructive")
db.command("status", "Show migration status").set_effects("read-only")
args = cli.run
case args.command
when %w[db migrate] then Clyops.info("migrating to #{args.target}")
end
```
