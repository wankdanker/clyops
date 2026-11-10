---
title: Java
---
# Java

Requires **Java 17+**. [Complete API reference](/reference/java/index.html) · [Shared behavior](../guide.md)

## Install and run

```sh
javac -cp clyops-0.13.0.jar DocsDemo.java
java -cp .:clyops-0.13.0.jar DocsDemo
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
java -cp .:clyops-0.13.0.jar DocsDemo --name Ada --count 2 --verbose
# Ada 2 true
java -cp .:clyops-0.13.0.jar DocsDemo --help
java -cp .:clyops-0.13.0.jar DocsDemo --help-json-schema
java -cp .:clyops-0.13.0.jar DocsDemo --count invalid
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

## Completion values from your program

`complete(name, fn)` lists the values of a value option, array option or
positional argument of that level, for values only the program can find, such
as the instances registered in a directory. They are offered when the user
presses Tab, and tooling (the HTTP API, MCP server and web runner) reads them
with `--complete-values`:

```java
cli.opt("INSTANCE", "instance", "i", "", "Instance to target");
cli.complete("instance", req -> {
    try (var files = Files.list(Path.of("/var/lib/myapp/instances"))) {
        return files.map(f -> f.getFileName().toString()).filter(n -> n.endsWith(".json"))
            .map(n -> n.substring(0, n.length() - 5)).toList();
    }
});
```

The function (`Completer`: `List<String> complete(CompleteRequest request)
throws Exception`) gets a `CompleteRequest(words, prefix, limit, offset)`:
`words` are the words typed after the command words, for completers that depend
on another option, and `prefix` is the text being completed. It runs only for
`--bash-completion` and `--complete-values`, so keep it quick (each Tab also
starts a JVM) and don't print to stdout. Throwing, or returning `null`, keeps
the rule's completion. The library drops empty values, `null`s and duplicates,
keeps the values starting with `prefix`, then skips `offset` and keeps `limit`,
so the function may return every value. It doesn't validate: check the value
after `run` if only listed values are allowed. Completing an unknown name or a
flag throws `IllegalArgumentException`; registering a name again replaces its
completer.

When the values come from a database, register with `complete(name, true, fn)`
and apply the request yourself. The function is then asked for one more value
than wanted (`limit` is never 0 here), so the library can tell whether more
remain:

```java
cli.complete("customer", true, req -> {
    try (var st = db.prepareStatement(
            "SELECT name FROM customers WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ? OFFSET ?")) {
        st.setString(1, req.prefix().replace("%", "\\%").replace("_", "\\_") + "%");
        st.setInt(2, req.limit());
        st.setInt(3, req.offset());
        var names = new ArrayList<String>();
        try (var rows = st.executeQuery()) {
            while (rows.next()) names.add(rows.getString(1));
        }
        return names;
    }
});
```

`prog --complete-values NAME PREFIX LIMIT OFFSET -- WORDS...` prints one page
as JSON, `{"values":[...],"more":false}`, and exits; values with spaces or
commas are kept there, while shell completion drops them and asks for at most
1000. In code, `completeValues(name, prefix, limit, offset, words)` returns a
`ValuesPage(values, more)`, or throws `IllegalArgumentException`
(`No completer for 'NAME'`) or `IllegalStateException`
(`Completer for 'NAME' failed`). See the [spec](../../spec/SPEC.md) sections
9.2 and 9.3.

## Parsing and errors

Use `run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
