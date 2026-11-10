# clyops (Rust)

One-line-per-option CLI parsing with validation, help text, config files, JSON schema, logging and
shell completion. Only dependency: `regex`. See the [main README](https://github.com/wankdanker/clyops).

```rust
use clyops::{info, Cli};

#[rustfmt::skip]
fn main() {
    let mut cli = Cli::new();
    cli.description("Copy files to a server.");
    cli.arg("SRC", "File to send", "", "file:exists");
    cli.arg_variadic("EXTRA", "More files", "file:exists");
    cli.opt("HOST", "host", "H", "localhost", "Server").group("Network").rule("hostname");
    cli.opt("PORT", "port", "p", "22", "Port").group("Network").rule("port");
    cli.opt("VERBOSE", "verbose", "v", "flag", "Chatty");
    cli.opt("CONFIG", "config", "c", "optional", "Config file").group("Config").rule("path");
    cli.config("config", "send:");
    let args = cli.run();

    info(&format!("sending {} to {}:{}", args.str("SRC"), args.str("HOST"), args.int("PORT")));
}
```

`run()` returns typed `Values` (`str`, `int`, `float`, `bool`, `strs`, `get`); `parse(&argv)` is the
non-exiting variant and returns `Parsed::{Ok, Help, Error}`. Registration mistakes (unknown rule,
duplicate name) panic. rustfmt splits long method chains, so `#[rustfmt::skip]` on the function
that registers options keeps one registration per line.

## Commands, relationships, secrets, effects and I/O

```rust
let db = cli.command("db", "Database tasks");              // a command: mytool db ...
let migrate = db.command("migrate", "Apply migrations");   // mytool db migrate
migrate.opt("TO", "to", "", "optional", "Target version").rule("int");
migrate.effects(&["destructive"]);                         // read-only, idempotent, destructive, network
cli.opt("TOKEN", "token", "t", "", "API token").group("Auth").rule("secret"); // masked in help and values_json()
cli.exclusive(&["json", "quiet"]);                         // also requires("a", &["b"]) and one_of(&[...])
cli.stdin("Audio to transcribe", "audio/wav");             // and stdout(description, content_type)
cli.role("progress", "out", "Progress", "application/x-ndjson");    // then cli.emit("progress", r#"{"pct":50}"#)
let args = cli.run();                                      // args.strs("command") == ["db", "migrate"]
```

`cli.command_path()` is the selected command words. Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](https://github.com/wankdanker/clyops/blob/main/spec/SPEC.md) sections 1.3 to 1.7.

## Completion values from your program

`complete(name, fn)` lists the values of an option or argument, read when the
user presses Tab and by tooling (`--complete-values`), for values only the
program can find, such as the instances registered in a directory:

```rust
cli.opt("INSTANCE", "instance", "i", "", "Instance to target");
cli.complete("instance", |_request| {
    let names = std::fs::read_dir("/var/lib/myapp/instances")?.filter_map(|e| e.ok()?.file_name().into_string().ok());
    Ok(names.filter_map(|n| n.strip_suffix(".json").map(String::from)).collect())
});
```

The closure (`Fn(&CompleteRequest) -> CompleteResult`, where `CompleteResult` is
`Result<Vec<String>, Box<dyn Error>>`) runs only for `--bash-completion` and
`--complete-values`, so keep it quick. The `CompleteRequest` carries `words`
(the words typed after the command words, for completers that depend on another
option), `prefix`, `limit` and `offset`. The library keeps the values that start
with `prefix` and pages them, so a completer can ignore those and return every
value. Returning an error, or panicking, keeps the rule's completion. It doesn't
validate: check the value after `run` if only listed values are allowed.

For a long list, register with `complete_paged` and apply the prefix, offset and
limit yourself, for example in a query. `limit` is one more than the page (so
the library can tell whether more remain) and `0` means no limit; the library
only truncates:

```rust
cli.complete_paged("customer", |req| {
    // SELECT name FROM customers WHERE name LIKE :prefix || '%' ORDER BY name LIMIT :limit OFFSET :offset
    // (no LIMIT when req.limit is 0)
    let names: Vec<String> = query_customers(&req.prefix, req.limit, req.offset)?;
    Ok(names)
});
```

`cli.complete_values(name, prefix, limit, offset, &words)` returns a
`ValuesPage { values, more }`, and `mytool --complete-values NAME PREFIX LIMIT
OFFSET -- WORDS...` prints it as JSON for the HTTP API, MCP server and web
runner. See the [spec](https://github.com/wankdanker/clyops/blob/main/spec/SPEC.md) sections 9.2 and 9.3.

## Documentation

Read the [language guide](https://clyops.io/languages/rust.html)
for installation, examples and editor setup, and the
[complete API reference](https://clyops.io/reference.html)
for public signatures, return values and errors. The
[Markdown sources](https://github.com/wankdanker/clyops/tree/main/docs/languages)
are also readable on GitHub.
