# clyops (Go)

One-line-per-option CLI parsing with validation, help text, config files, JSON schema, logging and
shell completion. Standard library only, Go 1.21+. See the
[main README](https://github.com/wankdanker/clyops).

```sh
go get github.com/wankdanker/clyops/packages/go
```

```go
package main

import clyops "github.com/wankdanker/clyops/packages/go"

func main() {
	cli := clyops.New()
	cli.SetDescription("Copy files to a server.")
	cli.Arg("SRC", "File to send", "", "file:exists")
	cli.ArgVariadic("EXTRA", "More files", "file:exists")
	cli.Opt("HOST", "host", "H", "localhost", "Server", "Network", "hostname")
	cli.Opt("PORT", "port", "p", "22", "Port", "Network", "port")
	cli.Opt("VERBOSE", "verbose", "v", "flag", "Chatty")
	cli.Opt("CONFIG", "config", "c", "optional", "Config file", "Config", "path")
	cli.SetConfig("config", "send:")
	args := cli.Run()

	clyops.Info("sending %s to %s:%d", args.String("SRC"), args.String("HOST"), args.Int("PORT"))
}
```

`Opt(variable, long, short, default, description, group, rule)`: the group and rule are optional
trailing arguments, as are `Arg`'s and `ArgVariadic`'s rule. `default` is a value, `"flag"`,
`"optional"`, or `""` for a required option; `OptArray` registers a repeatable one.

`Run()` handles `--help`, `--help-json-schema` and `--completion`, prints errors and exits, and
returns `Values`: a map keyed by option variable and argument name with typed getters (`String`,
`Int`, `Float`, `Bool`, `List`, `Strings`). Values validated by `int*` and `port` are `int`, `float*`
are `float64`, `bool` and flags are `bool`, arrays and variadics are `[]any`. `Parse(argv)` is the
non-exiting variant and returns a `ParseResult`.

Also: `Name`, `Root`, `Cwd` and `Env` fields to override the defaults; `Source`, `IsSet`,
`IsExplicitlySet`, `Usage`, `JSONSchema`, `CompletionScript`, `ValuesJSON`, `SetPathSearch`,
`RequireCommand`, the standalone `Validate`, `ResolvePath`, `DescribeRule` and `WrapText`, and the
logging helpers `Info`, `Warn`, `Error`, `Success`, `Die` and `SetSilent`. Registering an invalid
option (unknown rule, duplicate name) panics, since it is a programming error.

Shell completion: `eval "$(mytool --completion bash)"` (or `zsh`, `fish`). Go binaries are
recognized as clyops tools by [clyops-dispatch](../../apps/dispatch), the API and the MCP server
with no extra steps.

Versions are tagged `packages/go/vX.Y.Z` alongside each clyops release.
