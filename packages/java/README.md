# clyops (Java)

One-line-per-option CLI parsing with validation, help text, config files, JSON schema, logging and
shell completion. No dependencies, Java 17+. See the
[main README](https://github.com/wankdanker/clyops).

```xml
<dependency>
  <groupId>io.github.wankdanker</groupId>
  <artifactId>clyops</artifactId>
  <version>0.1.0</version>
</dependency>
```

The jar is also attached to each [GitHub release](https://github.com/wankdanker/clyops/releases).

```java
import io.github.wankdanker.clyops.Cli;
import io.github.wankdanker.clyops.Values;
import static io.github.wankdanker.clyops.Log.info;

public class Send {
    public static void main(String[] argv) {
        Cli cli = new Cli("send");
        cli.setDescription("Copy files to a server.");
        cli.arg("SRC", "File to send", "", "file:exists");
        cli.argVariadic("EXTRA", "More files", "file:exists");
        cli.opt("HOST", "host", "H", "localhost", "Server", "Network", "hostname");
        cli.opt("PORT", "port", "p", "22", "Port", "Network", "port");
        cli.opt("VERBOSE", "verbose", "v", "flag", "Chatty");
        cli.opt("CONFIG", "config", "c", "optional", "Config file", "Config", "path");
        cli.setConfig("config", "send:");
        Values args = cli.run(argv);

        info("sending %s to %s:%d", args.getString("SRC"), args.getString("HOST"), args.getInt("PORT"));
    }
}
```

`opt(var, long, short, default, description, group, rule)`: the group and rule are optional
trailing arguments, as are `arg`'s and `argVariadic`'s rule. `default` is a value, `"flag"`,
`"optional"`, or `""` for a required option; `optArray` registers a repeatable one. The name passed
to `new Cli(...)` is the program name shown in help and used by completion.

`run(argv)` handles `--help`, `--help-json-schema` and `--completion`, prints errors and exits, and
returns `Values`: an ordered map with typed getters (`getString`, `getInt`, `getLong`, `getDouble`,
`getBool`, `getList`, `getStrings`). Values validated by `int*` and `port` are `Long` (`BigInteger`
beyond a long), `float*` are `Double`, `bool` and flags are `Boolean`, arrays and variadics are
`List`s. `parse(argv)` is the non-exiting variant and returns a `ParseResult`.

Also: `setRoot`, `setCwd`, `setEnv`, `source`, `isSet`, `isExplicitlySet`, `usage`, `jsonSchema`,
`completionScript`, `valuesJson`, `setPathSearch`, `requireCommand`, the static `Cli.validate`,
`resolvePath`, `describeRule` and `wrapText`, and `Log.info`, `warn`, `error`, `success`, `die`
and `setSilent`. Registration mistakes (an unknown rule, a duplicate option) throw
`IllegalArgumentException`.

**Running it as a command.** Java programs usually ship as a jar with a small launcher script. Add
a `# clyops-tool` comment to the launcher so [clyops-dispatch](../../apps/dispatch), the API and
the MCP server recognize it (they can't see inside a jar):

```sh
#!/bin/sh
# clyops-tool
exec java -cp /opt/send/send.jar:/opt/send/clyops.jar Send "$@"
```

Shell completion: `eval "$(send --completion bash)"` (or `zsh`, `fish`). Completion starts a JVM
on each Tab press; for snappier completion on large tools, consider a native image (GraalVM).

## Commands, relationships, secrets, effects and I/O

```java
Cli db = cli.command("db", "Database tasks");              // a command: mytool db ...
Cli migrate = db.command("migrate", "Apply migrations");   // mytool db migrate
migrate.opt("TO", "to", "", "optional", "Target version", "Options", "int");
migrate.setEffects("destructive");                         // read-only, idempotent, destructive, network
cli.opt("TOKEN", "token", "t", "", "API token", "Auth", "secret"); // masked in help and valuesJson()
cli.exclusive("json", "quiet");                            // also requires("a", "b"...) and oneOf("a", "b"...)
cli.setStdin("Audio to transcribe", "audio/wav");          // and setStdout(description, contentType)
cli.run(argv);                                             // cli.commandPath() == [db, migrate]
```

Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.
