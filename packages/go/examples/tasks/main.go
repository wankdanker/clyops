// The conformance commands demo (spec/conformance/README.md) in Go.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	clyops "github.com/wankdanker/clyops/packages/go"
)

func main() {
	cli := clyops.New()
	cli.Name = "tasks"
	cli.Root = os.Getenv("DEMO_ROOT")
	cli.SetDescription("Commands demo for the clyops conformance suite.")
	cli.SetEpilog("Run 'tasks <command> --help' for a command's options.")
	cli.Opt("VERBOSE", "verbose", "v", "flag", "Verbose output", "Global")

	db := cli.Command("db", "Database tasks")
	db.Opt("DB_URL", "url", "u", "sqlite:app.db", "Database URL", "Database")
	migrate := db.Command("migrate", "Apply migrations")
	migrate.Arg("target", "Target version", "latest")
	migrate.Opt("DRY_RUN", "dry-run", "n", "flag", "Show what would run")
	migrate.SetEffects("destructive")
	db.Command("status", "Show migration status").SetEffects("read-only")

	send := cli.Command("send", "Send a message")
	send.Arg("message", "Message text", "")
	send.Opt("WEBHOOK", "webhook", "w", "optional", "Webhook URL", "Options", "url")
	send.Opt("EMAIL", "email", "e", "optional", "Email address", "Options", "email")
	send.OneOf("webhook", "email")
	send.SetEffects("network")
	send.SetStdin("Attachment", "application/octet-stream")

	cli.Run()
	var values any
	if err := json.Unmarshal([]byte(cli.ValuesJSON()), &values); err != nil {
		panic(err)
	}
	out, _ := json.MarshalIndent(map[string]any{"values": values}, "", "  ")
	fmt.Println(string(out))
}
