// The conformance commands demo (spec/conformance/README.md) in Go.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	clyops "github.com/wankdanker/clyops/packages/go"
)

// versions is a completer (spec section 9.2): v1, v2, then w: and each word it was given.
func versions(req clyops.CompleteRequest) ([]string, error) {
	values := []string{"v1", "v2"}
	for _, w := range req.Words {
		values = append(values, "w:"+w)
	}
	return values, nil
}

func main() {
	cli := clyops.New()
	cli.Name = "tasks"
	cli.Root = os.Getenv("DEMO_ROOT")
	cli.SetDescription("Commands demo for the clyops conformance suite.")
	cli.SetEpilog("Run 'tasks <command> --help' for a command's options.")
	cli.Opt("VERBOSE", "verbose", "v", "flag", "Verbose output", "Global")
	cli.Role("progress", "out", "Progress, one JSON object per line", "application/x-ndjson", nil)

	db := cli.Command("db", "Database tasks")
	db.Opt("DB_URL", "url", "u", "sqlite:app.db", "Database URL", "Database")
	db.Complete("url", func(clyops.CompleteRequest) ([]string, error) { return []string{"sqlite:app.db", "pg:main"}, nil })
	migrate := db.Command("migrate", "Apply migrations")
	migrate.Arg("target", "Target version", "latest")
	migrate.Opt("DRY_RUN", "dry-run", "n", "flag", "Show what would run")
	migrate.Complete("target", versions)
	migrate.SetEffects("destructive")
	migrate.Role("plan", "out", "Migration plan", "text/plain", nil)
	db.Command("status", "Show migration status").SetEffects("read-only")

	send := cli.Command("send", "Send a message")
	send.Arg("message", "Message text", "")
	send.Opt("WEBHOOK", "webhook", "w", "optional", "Webhook URL", "Options", "url")
	send.Opt("EMAIL", "email", "e", "optional", "Email address", "Options", "email")
	send.OneOf("webhook", "email")
	send.SetEffects("network")
	send.SetStdin("Attachment", "application/octet-stream")

	cli.Run()
	cli.Emit("progress", `{"stage":"done"}`)
	var values any
	if err := json.Unmarshal([]byte(cli.ValuesJSON()), &values); err != nil {
		panic(err)
	}
	out, _ := json.MarshalIndent(map[string]any{"values": values}, "", "  ")
	fmt.Println(string(out))
}
