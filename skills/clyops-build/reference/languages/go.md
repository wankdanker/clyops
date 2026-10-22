# clyops in Go

Go 1.21+, standard library only.

## Install

```sh
go get github.com/wankdanker/clyops/packages/go@v0.9.0
```

Pin the release the project uses. Compiled clyops binaries embed their
completion header, which is how the dispatcher, API and MCP server recognize
them: no marker comment needed.

## Registration

```go
import clyops "github.com/wankdanker/clyops/packages/go"

cli := clyops.New()
cli.Name = "plan"                                   // also cli.Root
cli.Opt(VAR, long, short, def, description, group, rule)   // group, rule optional
cli.OptArray(VAR, long, short, description, group, rule)
cli.Arg(NAME, description, def, rule)                      // def, rule optional
cli.ArgVariadic(NAME, description, rule)
```

Metadata: `SetDescription`, `SetEpilog`, `SetConfig(option, prefixes)`,
`SetPathSearch(long, dirs)`, `RequireCommand(cmd, description, hint)`,
`SetEffects(effects...)`, `SetStdin(description, contentType)`,
`SetStdout(description, contentType)`, `Exclusive(longs...)`,
`Requires(longs...)`, `OneOf(longs...)`, `Command(name, description)`.

## Values

`args := cli.Run()` returns `Values` with typed getters: `String`, `Int`,
`Float`, `Bool`, `Strings` (arrays/variadics), `List`. `cli.CommandPath()` is
the selected command words.

Also `cli.Source(long)`, `cli.ValuesJSON()`, and non-exiting `cli.Parse(argv)`.

## Logging

`clyops.Info`, `Warn`, `Error`, `Success` take a printf format;
`clyops.Die(code, format, args...)` logs and exits; `clyops.SetSilent(true)`.

## Example

```go
package main

import (
	"encoding/json"
	"fmt"

	clyops "github.com/wankdanker/clyops/packages/go"
)

func main() {
	cli := clyops.New()
	cli.Name = "plan"
	cli.SetDescription("Build a deployment plan. Change nothing.")
	cli.Opt("SERVICE", "service", "s", "api", "Service", "Options", "choice:api,worker")
	cli.Opt("ENV", "env", "e", "staging", "Environment", "Options", "choice:staging,production")
	cli.Opt("REPLICAS", "replicas", "r", "2", "Replica count", "Options", "int:1-10")
	cli.OptArray("TAG", "tag", "t", "Labels to attach", "Options", "string:1-40")
	cli.Opt("WEBHOOK", "webhook", "", "optional", "Notify this webhook", "Notification", "url")
	cli.Opt("EMAIL", "email", "", "optional", "Notify this email address", "Notification", "email")
	cli.Exclusive("webhook", "email")
	cli.SetEffects("read-only")
	cli.SetStdout("Deployment plan", "application/json")
	args := cli.Run()

	// Our tool's logic starts here, after the interface is fully declared.
	out, _ := json.Marshal(map[string]any{"service": args.String("SERVICE"), "env": args.String("ENV"),
		"replicas": args.Int("REPLICAS"), "tags": args.Strings("TAG")})
	fmt.Println(string(out))
}
```

## Commands

```go
cli.Opt("VERBOSE", "verbose", "v", "flag", "Verbose output", "Global") // program options first
db := cli.Command("db", "Database tasks")
db.Opt("DB_URL", "url", "u", "sqlite:app.db", "Database URL", "Database")
migrate := db.Command("migrate", "Apply migrations")
migrate.Arg("target", "Target version", "latest")
migrate.Opt("DRY_RUN", "dry-run", "n", "flag", "Show what would run")
migrate.SetEffects("destructive")
db.Command("status", "Show migration status").SetEffects("read-only")
args := cli.Run()
if strings.Join(cli.CommandPath(), " ") == "db migrate" { /* ... */ }
```
