// The conformance commands demo (spec/conformance/README.md) in Java.
import io.github.wankdanker.clyops.Cli;

public class Tasks {
    public static void main(String[] argv) {
        Cli cli = new Cli("tasks").setRoot(System.getenv("DEMO_ROOT"));
        cli.setDescription("Commands demo for the clyops conformance suite.");
        cli.setEpilog("Run 'tasks <command> --help' for a command's options.");
        cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output", "Global");

        Cli db = cli.command("db", "Database tasks");
        db.opt("DB_URL", "url", "u", "sqlite:app.db", "Database URL", "Database");
        Cli migrate = db.command("migrate", "Apply migrations");
        migrate.arg("target", "Target version", "latest");
        migrate.opt("DRY_RUN", "dry-run", "n", "flag", "Show what would run");
        migrate.setEffects("destructive");
        db.command("status", "Show migration status").setEffects("read-only");

        Cli send = cli.command("send", "Send a message");
        send.arg("message", "Message text", "");
        send.opt("WEBHOOK", "webhook", "w", "optional", "Webhook URL", "Options", "url");
        send.opt("EMAIL",   "email",   "e", "optional", "Email address", "Options", "email");
        send.oneOf("webhook", "email");
        send.setEffects("network");
        send.setStdin("Attachment", "application/octet-stream");

        cli.run(argv);
        System.out.println("{\n  \"values\": " + cli.valuesJson().replace("\n", "\n  ") + "\n}");
    }
}
