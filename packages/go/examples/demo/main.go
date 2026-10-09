// The conformance demo CLI (spec/conformance/README.md) in Go.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	clyops "github.com/wankdanker/clyops/packages/go"
)

func main() {
	cli := clyops.New()
	cli.Name = "demo"
	cli.Root = os.Getenv("DEMO_ROOT")
	cli.SetDescription("Demo program for the clyops conformance suite. It registers one of every kind of option and argument so that each implementation can be checked against the same help text, schema and resolved values.")
	cli.SetEpilog("Examples:\n  demo in.txt slow a b --tag x --tag y\n  demo in.txt -vc demo.conf")
	cli.RequireCommand("sh", "POSIX shell", "install dash")
	cli.SetEffects("idempotent", "network")
	cli.SetStdin("Lines to process", "text/plain")
	cli.SetStdout("The resolved values", "application/json")

	cli.Arg("input", "Input file", "", "path")
	cli.Arg("mode", "Processing mode", "fast", "choice:fast,slow")
	cli.ArgVariadic("rest", "Extra items")

	cli.Opt("CONFIG", "config", "c", "optional", "Config file to load", "Config", "path")
	cli.Opt("VERBOSE", "verbose", "v", "flag", "Enable verbose output", "Output")
	cli.Opt("QUIET", "quiet", "q", "flag", "Suppress output", "Output")
	cli.Opt("COLOR", "color", "", "auto", "When to use color", "Output", "choice:auto,always,never")
	cli.Opt("OUT", "out", "o", "out.txt", "Output path", "Output", "path")
	cli.Opt("NOTES", "notes", "", "optional", "Free-form notes. This description is deliberately long so that the help output has to wrap it onto several lines at the default width of one hundred columns.", "Output")
	cli.Opt("COUNT", "count", "n", "3", "Number of iterations", "Options", "int:1-10")
	cli.Opt("RATIO", "ratio", "", "0.5", "Mix ratio", "Options", "float:0-1")
	cli.Opt("ENABLED", "enabled", "", "true", "Enable processing", "Options", "bool")
	cli.OptArray("TAG", "tag", "t", "Tag to attach", "Options", "string:1-8")
	cli.Opt("NO_CACHE", "no-cache", "", "flag", "Disable the cache", "Options")
	cli.Opt("KEY", "key", "k", "", "API key", "Auth", "secret")
	cli.Opt("HOST", "host", "H", "localhost", "Server host", "Network", "hostname")
	cli.Opt("PORT", "port", "p", "8080", "Server port", "Network", "port")
	cli.Opt("ENDPOINT", "endpoint", "", "optional", "Endpoint URL", "Network", "url")
	cli.Opt("ADDR", "addr", "", "optional", "Bind address", "Network", "ip")
	cli.Opt("ID", "id", "", "optional", "Request identifier", "Validation", "uuid")
	cli.Opt("EMAIL", "email", "", "optional", "Contact email", "Validation", "email")
	cli.Opt("DATE", "date", "", "optional", "Start date", "Validation", "date:YYYY-MM-DD")
	cli.Opt("CODE", "code", "", "optional", "Three-letter code", "Validation", "regex:^[A-Z]{3}$")
	cli.Opt("LEVEL", "level", "", "optional", "Level", "Validation", "int")
	cli.Opt("SIZE", "size", "", "optional", "Size code", "Validation", "string:4")
	cli.Opt("DATA_DIR", "data-dir", "d", "optional", "Data directory", "Files", "dir:exists")
	cli.Opt("SRC", "src", "", "optional", "Source file", "Files", "file:exists")
	cli.Opt("DEST", "dest", "", "optional", "Destination file", "Files", "file:writable")
	cli.OptArray("INCLUDE", "include", "I", "Include directory", "Files", "path")

	cli.SetConfig("config", "demo:,shared:")
	cli.SetPathSearch("config", "conf")
	cli.Exclusive("endpoint", "addr")
	cli.Requires("dest", "src")

	cli.Run()

	longs := []string{"config", "verbose", "quiet", "color", "out", "notes", "count", "ratio", "enabled", "tag", "no-cache", "key",
		"host", "port", "endpoint", "addr", "id", "email", "date", "code", "level", "size", "data-dir", "src", "dest",
		"include", "help"}
	sources := map[string]string{}
	for _, l := range longs {
		sources[l] = cli.Source(l)
	}
	out, _ := json.MarshalIndent(map[string]any{"values": json.RawMessage(cli.ValuesJSON()), "sources": sources}, "", "  ")
	fmt.Println(string(out))
}
