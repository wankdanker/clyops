---
title: Java
---
# Java

Requires **Java 17+**. [Complete API reference](/reference/java/index.html) · [Shared behavior](../guide.md)

## Install and run

```sh
javac -cp clyops-0.12.1.jar DocsDemo.java
java -cp .:clyops-0.12.1.jar DocsDemo
```

Download matching JARs from the [GitHub release](https://github.com/wankdanker/clyops/releases). On Windows, use `;` instead of `:` in the classpath. The compile command assumes the source file below has been saved beside the downloaded JAR.

Save the following as `DocsDemo.java`:

<!-- example: DocsDemo.java -->
```java
import io.github.wankdanker.clyops.Cli;
import io.github.wankdanker.clyops.Values;

public class DocsDemo {
    public static void main(String[] argv) {
        Cli cli = new Cli("docs-demo");
        cli.opt("NAME", "name", "n", "World", "Who to greet");
        cli.opt("COUNT", "count", "c", "1", "Repeat count", "Options", "int:1-3");
        cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output");
        Values args = cli.run(argv);
        System.out.printf("%s %d %s%n", args.getString("NAME"), args.getInt("COUNT"), args.getBool("VERBOSE"));
    }
}
```

```sh
java -cp .:clyops-0.12.1.jar DocsDemo --name Ada --count 2 --verbose
# Ada 2 true
java -cp .:clyops-0.12.1.jar DocsDemo --help
java -cp .:clyops-0.12.1.jar DocsDemo --help-json-schema
java -cp .:clyops-0.12.1.jar DocsDemo --count invalid
# Validation error; exit status 1
```

## Editor support and resolved values

IntelliJ IDEA, Eclipse and Java language servers read compiled signatures. Attach the matching `-sources.jar` and `-javadoc.jar` for source navigation and hover documentation. `mvn package` builds them locally; the next release will attach them alongside the main JAR. Maven Central publication is not configured yet; use the GitHub release artifacts or install the JARs locally.

## Commands, relationships, secrets, effects and I/O

Add these registrations before calling `run`. A CLI level has either subcommands or positional arguments.

```java
Cli db = cli.command("db", "Database tasks");              // a command: mytool db ...
Cli migrate = db.command("migrate", "Apply migrations");   // mytool db migrate
migrate.opt("TO", "to", "", "optional", "Target version", "Options", "int");
migrate.setEffects("destructive");                         // read-only, idempotent, destructive, network
cli.opt("TOKEN", "token", "t", "", "API token", "Auth", "secret"); // masked in help and valuesJson()
cli.opt("JSON", "json", "", "flag", "JSON output");
cli.opt("QUIET", "quiet", "", "flag", "Quiet output");
cli.exclusive("json", "quiet");                            // also requires("a", "b"...) and oneOf("a", "b"...)
cli.setStdin("Audio to transcribe", "audio/wav");          // and setStdout(description, contentType)
cli.role("progress", "out", "Progress", "application/x-ndjson");  // then cli.emit("progress", "{\"pct\":50}")
cli.run(argv);                                             // cli.commandPath() == [db, migrate]
```

Roles (`role`, `emit`): the JVM can't write to a descriptor number directly, so
`emit` reopens `/dev/fd/N`, which works for pipes and files. For a socket (Node's
`child_process` pipes are socketpairs), start the JVM with
`--add-opens java.base/java.io=ALL-UNNAMED`; without it, `emit` warns once and
writes nothing. Java also can't remove `CLYOPS_FDS` from its own environment, so
a program that starts others removes it from `ProcessBuilder.environment()`, or
sets it to `forwardFds(...)`.

Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.

## Parsing and errors

Use `run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
