//! The conformance commands demo (spec/conformance/README.md) in Rust.
use clyops::Cli;

// Keep one registration per line; rustfmt would split the chains.
#[rustfmt::skip]
fn main() {
    let mut cli = Cli::new();
    cli.name("tasks").root(&std::env::var("DEMO_ROOT").unwrap_or_else(|_| ".".into()));
    cli.description("Commands demo for the clyops conformance suite.");
    cli.epilog("Run 'tasks <command> --help' for a command's options.");
    cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output").group("Global");

    let db = cli.command("db", "Database tasks");
    db.opt("DB_URL", "url", "u", "sqlite:app.db", "Database URL").group("Database");
    let migrate = db.command("migrate", "Apply migrations");
    migrate.arg("target", "Target version", "latest", "");
    migrate.opt("DRY_RUN", "dry-run", "n", "flag", "Show what would run");
    migrate.effects(&["destructive"]);
    db.command("status", "Show migration status").effects(&["read-only"]);

    let send = cli.command("send", "Send a message");
    send.arg("message", "Message text", "", "");
    send.opt("WEBHOOK", "webhook", "w", "optional", "Webhook URL").rule("url");
    send.opt("EMAIL",   "email",   "e", "optional", "Email address").rule("email");
    send.one_of(&["webhook", "email"]);
    send.effects(&["network"]);
    send.stdin("Attachment", "application/octet-stream");

    cli.run();
    println!("{{\"values\": {}}}", cli.values_json());
}
