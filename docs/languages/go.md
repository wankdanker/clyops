---
title: Go
---
# Go

Requires **Go 1.21+**. [Complete API reference](/reference/go/index.html) · [Shared behavior](../guide.md)

## Install and run

```sh
go get github.com/wankdanker/clyops/packages/go@v0.12.1
```

Save the following as `quickstart.go`:

<!-- example: quickstart.go -->
```go
package main

import (
	"fmt"
	"github.com/wankdanker/clyops/packages/go"
)

func main() {
	cli := clyops.New()
	cli.Name = "docs-demo"
	cli.Opt("NAME", "name", "n", "World", "Who to greet")
	cli.Opt("COUNT", "count", "c", "1", "Repeat count", "Options", "int:1-3")
	cli.Opt("VERBOSE", "verbose", "v", "flag", "Verbose output")
	args := cli.Run()
	fmt.Printf("%s %d %t\n", args.String("NAME"), args.Int("COUNT"), args.Bool("VERBOSE"))
}
```

```sh
go run quickstart.go --name Ada --count 2 --verbose
# Ada 2 true
go run quickstart.go --help
go run quickstart.go --help-json-schema
go run quickstart.go --count invalid
# Validation error; exit status 1
```

## Editor support and resolved values

gopls reads signatures and exported-symbol comments. `go doc github.com/wankdanker/clyops/packages/go` shows the installed API; pkg.go.dev renders the same source comments for published module versions.

## Commands, relationships, secrets, effects and I/O

Add these registrations before calling `run`. A CLI level has either subcommands or positional arguments.

```go
db := cli.Command("db", "Database tasks")                // a command: mytool db ...
migrate := db.Command("migrate", "Apply migrations")     // mytool db migrate
migrate.Opt("TO", "to", "", "optional", "Target version", "Options", "int")
migrate.SetEffects("destructive")                        // read-only, idempotent, destructive, network
cli.Opt("TOKEN", "token", "t", "", "API token", "Auth", "secret") // masked in help and ValuesJSON()
cli.Exclusive("json", "quiet")                           // also Requires("a", "b"...) and OneOf("a", "b"...)
cli.SetStdin("Audio to transcribe", "audio/wav")         // and SetStdout(description, contentType)
cli.Role("progress", "out", "Progress", "application/x-ndjson", nil) // then cli.Emit("progress", map[string]int{"pct": 50})
v := cli.Run()                                           // cli.CommandPath() == []string{"db", "migrate"}
```

Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.

## Parsing and errors

Use `Run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `Parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
