#!/usr/bin/env python3
"""The conformance commands demo (spec/conformance/README.md) in Python."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from clyops import Cli  # noqa: E402

cli = Cli(name="tasks", root=os.environ.get("DEMO_ROOT"))
cli.set_description("Commands demo for the clyops conformance suite.")
cli.set_epilog("Run 'tasks <command> --help' for a command's options.")
cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output", "Global")

db = cli.command("db", "Database tasks")
db.opt("DB_URL", "url", "u", "sqlite:app.db", "Database URL", "Database")
migrate = db.command("migrate", "Apply migrations")
migrate.arg("target", "Target version", "latest")
migrate.opt("DRY_RUN", "dry-run", "n", "flag", "Show what would run")
migrate.set_effects("destructive")
status = db.command("status", "Show migration status")
status.set_effects("read-only")

send = cli.command("send", "Send a message")
send.arg("message", "Message text")
send.opt("WEBHOOK", "webhook", "w", "optional", "Webhook URL", "Options", "url")
send.opt("EMAIL",   "email",   "e", "optional", "Email address", "Options", "email")
send.one_of("webhook", "email")
send.set_effects("network")
send.set_stdin("Attachment", "application/octet-stream")

cli.run()
print(json.dumps({"values": json.loads(cli.values_json())}, indent=2))
