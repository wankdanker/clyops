# clyops in Java

Java 17+, no dependencies.

## Install

Download `clyops-<version>.jar` from the
[GitHub release](https://github.com/wankdanker/clyops/releases) (Maven Central
publication is not configured yet) and put it on the classpath.

**Java tools are run through a launcher script, which is not recognized
automatically** by the dispatcher, API or MCP server. Put an exact standalone
`# clyops-tool` comment within the first ten lines of the launcher:

```sh
#!/bin/sh
# clyops-tool
here=$(cd "$(dirname "$0")" && pwd)
exec java -cp "$here/classes:$here/clyops-0.12.1.jar" Plan "$@"
```

## Registration

```java
import io.github.wankdanker.clyops.Cli;
import io.github.wankdanker.clyops.Values;
import static io.github.wankdanker.clyops.Log.*;

Cli cli = new Cli("plan");                       // .setRoot(path)
cli.opt(VAR, long, short, def, description, group, rule);   // group, rule optional
cli.optArray(VAR, long, short, description, group, rule);
cli.arg(NAME, description, def, rule);                      // def, rule optional
cli.argVariadic(NAME, description, rule);
```

Metadata: `setDescription`, `setEpilog`, `setConfig(option, prefixes)`,
`setPathSearch(long, dirs)`, `requireCommand(cmd, description, hint)`,
`setEffects(effects...)`, `setStdin(description, contentType)`,
`setStdout(description, contentType)`, `exclusive(longs...)`,
`requires(longs...)`, `oneOf(longs...)`, `command(name, description)`.

## Values

`Values args = cli.run(argv);` with typed getters `getString`, `getInt`,
`getLong`, `getDouble`, `getBool`, `getStrings` (arrays/variadics), `getList`.
`cli.commandPath()` is the selected command words.

Also `cli.source(long)`, `cli.valuesJson()`, and non-exiting `cli.parse(argv)`.

## Logging

`Log.info`, `warn`, `error`, `success` take a `String.format` format;
`Log.die(code, format, args...)` logs and exits; `Log.setSilent(true)`.

## Example

```java
import io.github.wankdanker.clyops.Cli;
import io.github.wankdanker.clyops.Values;

public class Plan {
    public static void main(String[] argv) {
        Cli cli = new Cli("plan");
        cli.setDescription("Build a deployment plan. Change nothing.");
        cli.opt("SERVICE", "service", "s", "api", "Service", "Options", "choice:api,worker");
        cli.opt("ENV", "env", "e", "staging", "Environment", "Options", "choice:staging,production");
        cli.opt("REPLICAS", "replicas", "r", "2", "Replica count", "Options", "int:1-10");
        cli.optArray("TAG", "tag", "t", "Labels to attach", "Options", "string:1-40");
        cli.opt("WEBHOOK", "webhook", "", "optional", "Notify this webhook", "Notification", "url");
        cli.opt("EMAIL", "email", "", "optional", "Notify this email address", "Notification", "email");
        cli.exclusive("webhook", "email");
        cli.setEffects("read-only");
        cli.setStdout("Deployment plan", "text/plain");
        Values args = cli.run(argv);

        // Our tool's logic starts here, after the interface is fully declared.
        System.out.printf("service=%s env=%s replicas=%d tags=%s%n", args.getString("SERVICE"), args.getString("ENV"),
            args.getInt("REPLICAS"), String.join(",", args.getStrings("TAG")));
    }
}
```

## Commands

```java
cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output", "Global");   // program options first
Cli db = cli.command("db", "Database tasks");
db.opt("DB_URL", "url", "u", "sqlite:app.db", "Database URL", "Database");
Cli migrate = db.command("migrate", "Apply migrations");
migrate.arg("target", "Target version", "latest");
migrate.opt("DRY_RUN", "dry-run", "n", "flag", "Show what would run");
migrate.setEffects("destructive");
db.command("status", "Show migration status").setEffects("read-only");
Values args = cli.run(argv);
if (cli.commandPath().equals(java.util.List.of("db", "migrate"))) { /* ... */ }
```
